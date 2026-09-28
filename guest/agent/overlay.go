package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
)

// store はコミットを OverlayFS の層として持つ（命令の形 v1、docs/agent-protocol.md）。
//
// 層の名前（id）はホストが決める文字列で、MicroGit では Git のコミットのハッシュを使う。
// ディスク上のディレクトリ名は短い番号（l0, l1, ...）にする。lowerdir のオプション文字列は
// 従来の mount(2) では 1 ページ（4096 バイト）までなので、40 文字のハッシュをそのまま使うと
// 余裕が小さい（docs/adr/0003-layer-compaction.md）。
//
// コミットのモデル（FR-2、#12 で「保存ごとに層を作る」に決定）:
//
//	コミット = 親までの層を lowerdir に積み、空の upperdir に ops を書いて unmount したもの。
//	凍結した upper がそのまま子の lower になる。view は親までの層＋自分の層だけの読み取り専用 mount。
//
// 層は正本ではなくキャッシュ（ADR-0001）。ホストはいつでも reset して Git から作り直せる。
type store struct {
	root   string
	layers map[string]*layer
	opSets map[string][][]string
	next   int
}

type layer struct {
	dir    string // root からの相対（"l0" など）
	parent string // 親の id。空なら親なし（base の上）
	depth  int    // 自分を含めた層の数（base を除く）
}

type commitInfo struct {
	existed      bool
	depth        int
	mountOptions string
	exdevRenames int
}

// overlayOpts は固定する mount オプション（#12、O-13）。record-kernel.mjs の MOUNT_OPTS と同じにする。
//
//	userxattr          非特権（ユーザー名前空間の root）で mount するのに必須（カーネル 5.11 以降）。
//	                   tmpfs を upper にするには tmpfs の user.* xattr（6.6 以降）も要る
//	redirect_dir=nofollow  下の層のディレクトリの rename は EXDEV にする。userxattr と redirect_dir=on は
//	                   カーネルが同時に受け付けない（"conflicting options"。2026-09-26 に 6.6 で確認）
//	index=off / metacopy=off / xino=off  カーネルの版や設定で既定値が変わりうるものを明示して揃える。
//	                   metacopy=on も userxattr と同時には受け付けない
const overlayOpts = "userxattr,redirect_dir=nofollow,index=off,metacopy=off,xino=off"

// maxDepth は 1 つの view に積める層の数の上限（安全のため）。OverlayFS は 500 層まで。
// どこで写しの層に切り替えるかはホストが決める（ADR-0003 では 32）。
const maxDepth = 400

// maxOptionBytes は mount(2) に渡すオプション文字列の上限（1 ページ）。
const maxOptionBytes = 4096

// maxReadBytes は read / readMany で 1 回に返す中身の合計の上限。応答は 1 行の JSON なので大きくしない。
const maxReadBytes = 32 << 20
const maxChunkBytes = 32 << 10
const maxUploadBytes = 90 << 20

func newStore(root string) (*store, error) {
	s := &store{root: root}
	return s, s.reset()
}

func (s *store) abs(rel string) string { return filepath.Join(s.root, rel) }
func (s *store) mnt() string           { return s.abs("m") }
func (s *store) base() string          { return s.abs("base") }
func (s *store) uploads() string       { return s.abs("uploads") }

func (s *store) reset() error {
	_ = syscall.Unmount(s.mnt(), 0)
	if err := os.RemoveAll(s.root); err != nil {
		return err
	}
	s.layers = map[string]*layer{}
	s.opSets = map[string][][]string{}
	s.next = 0
	for _, d := range []string{s.base(), s.mnt(), s.uploads()} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	return nil
}

func validUploadID(id string) bool {
	if id == "" || len(id) > 128 {
		return false
	}
	for _, c := range id {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

// stage は、大きいファイルを virtio-console の安全な大きさに分けて一時領域へ受け取る。
// upload は commit の writeupload からだけ参照し、reset と commit 後に消す。
func (s *store) stage(upload, encoded string, appendData bool) error {
	if !validUploadID(upload) {
		return &protoError{code: "BAD_REQUEST", msg: "bad upload id"}
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(data) > maxChunkBytes {
		return &protoError{code: "BAD_REQUEST", msg: fmt.Sprintf("bad stage data (max %d bytes)", maxChunkBytes)}
	}
	p := filepath.Join(s.uploads(), upload)
	if appendData {
		if _, err := os.Stat(p); err != nil {
			return &protoError{code: "BAD_REQUEST", msg: "upload does not exist"}
		}
	}
	flags := os.O_CREATE | os.O_WRONLY
	if appendData {
		flags |= os.O_APPEND
	} else {
		flags |= os.O_TRUNC
	}
	f, err := os.OpenFile(p, flags, 0o600)
	if err != nil {
		return err
	}
	if _, err = f.Write(data); err == nil {
		err = f.Close()
	} else {
		_ = f.Close()
	}
	if err != nil {
		return err
	}
	if st, err := os.Stat(p); err != nil {
		return err
	} else if st.Size() > maxUploadBytes {
		_ = os.Remove(p)
		return &protoError{code: "TOO_LARGE", msg: fmt.Sprintf("upload exceeds %d bytes", maxUploadBytes)}
	}
	return nil
}

// stageOp は、ファイル数が多く commit のメタデータ自体が1フレームに収まらない場合に
// opを1件ずつ受け取る。ファイルの中身はstageで別に受け取るので、各opはパスと参照だけ。
func (s *store) stageOp(upload string, op []string, appendOp bool) error {
	if !validUploadID(upload) || len(op) == 0 {
		return &protoError{code: "BAD_REQUEST", msg: "bad staged op"}
	}
	if !appendOp {
		delete(s.opSets, upload)
	} else if _, ok := s.opSets[upload]; !ok {
		return &protoError{code: "BAD_REQUEST", msg: "staged ops do not exist"}
	}
	if len(s.opSets[upload]) >= 100_000 {
		delete(s.opSets, upload)
		return &protoError{code: "TOO_LARGE", msg: "too many staged ops"}
	}
	s.opSets[upload] = append(s.opSets[upload], append([]string(nil), op...))
	return nil
}

func (s *store) resolveOps(direct [][]string, upload string) ([][]string, error) {
	if upload == "" {
		return direct, nil
	}
	if len(direct) != 0 || !validUploadID(upload) {
		return nil, &protoError{code: "BAD_REQUEST", msg: "commit must use direct ops or opsUpload, not both"}
	}
	ops, ok := s.opSets[upload]
	if !ok {
		return nil, &protoError{code: "BAD_REQUEST", msg: "staged ops do not exist"}
	}
	delete(s.opSets, upload)
	return ops, nil
}

// lowerdirs は id から親をたどった層のディレクトリを、上の層が先の順で返す。最後は空の base。
// 読み取り専用の overlay は lowerdir が 2 つ以上いるので、base を必ず足す。
func (s *store) lowerdirs(id string) []string {
	var dirs []string
	for n := id; n != ""; n = s.layers[n].parent {
		dirs = append(dirs, s.abs(s.layers[n].dir))
	}
	return append(dirs, s.base())
}

func checkOptions(data string) error {
	if len(data) >= maxOptionBytes {
		return &protoError{code: "OPTIONS_TOO_LONG", msg: fmt.Sprintf("mount options are %d bytes (limit %d)", len(data), maxOptionBytes)}
	}
	return nil
}

func (s *store) commit(id, parent string, ops [][]string) (commitInfo, error) {
	var info commitInfo
	defer s.cleanupUploads(ops)
	if id == "" {
		return info, &protoError{code: "BAD_REQUEST", msg: "commit needs layer"}
	}
	if l, ok := s.layers[id]; ok {
		// 同じ id の層がもうある。ホストの再送や、別の枝から同じコミットに届いた場合。
		// 層は Git のコミットと 1 対 1 なので、中身は同じはず。作り直さずにそのまま返す
		if l.parent != parent {
			return info, &protoError{code: "EEXIST", msg: fmt.Sprintf("layer %s exists with a different parent", id)}
		}
		return commitInfo{existed: true, depth: l.depth}, nil
	}
	lowers := []string{s.base()}
	depth := 1
	if parent != "" {
		p, ok := s.layers[parent]
		if !ok {
			return info, &protoError{code: "UNKNOWN_LAYER", msg: "unknown parent " + parent}
		}
		lowers = s.lowerdirs(parent)
		depth = p.depth + 1
	}
	if depth > maxDepth {
		return info, &protoError{code: "TOO_DEEP", msg: fmt.Sprintf("depth %d exceeds %d", depth, maxDepth)}
	}
	dir := fmt.Sprintf("l%d", s.next)
	work := fmt.Sprintf("w%d", s.next)
	data := fmt.Sprintf("lowerdir=%s,upperdir=%s,workdir=%s,%s", strings.Join(lowers, ":"), s.abs(dir), s.abs(work), overlayOpts)
	if err := checkOptions(data); err != nil {
		return info, err
	}
	for _, d := range []string{s.abs(dir), s.abs(work)} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return info, err
		}
	}
	if err := syscall.Mount("overlay", s.mnt(), "overlay", 0, data); err != nil {
		return info, fmt.Errorf("mount overlay: %w", err)
	}
	info.mountOptions = currentMountOptions(s.mnt())
	opErr := func() error {
		for _, op := range ops {
			var n int
			var err error
			if len(op) > 0 && op[0] == "writeupload" {
				err = s.applyUploadOp(s.mnt(), op)
			} else {
				n, err = applyOp(s.mnt(), op)
			}
			if err != nil {
				return fmt.Errorf("op %v: %w", opSummary(op), err)
			}
			info.exdevRenames += n
		}
		return nil
	}()
	if err := syscall.Unmount(s.mnt(), 0); err != nil && opErr == nil {
		opErr = fmt.Errorf("unmount: %w", err)
	}
	// workdir は mount 中だけ使う作業場所。凍結した層には要らない
	_ = os.RemoveAll(s.abs(work))
	if opErr != nil {
		_ = os.RemoveAll(s.abs(dir))
		return info, opErr
	}
	s.next++
	s.layers[id] = &layer{dir: dir, parent: parent, depth: depth}
	info.depth = depth
	return info, nil
}

func (s *store) cleanupUploads(ops [][]string) {
	for _, op := range ops {
		if len(op) >= 3 && op[0] == "writeupload" && validUploadID(op[2]) {
			_ = os.Remove(filepath.Join(s.uploads(), op[2]))
		}
	}
}

func (s *store) applyUploadOp(root string, op []string) error {
	if len(op) < 3 || len(op) > 4 || !validUploadID(op[2]) {
		return &protoError{code: "BAD_REQUEST", msg: fmt.Sprintf("bad op %v", opSummary(op))}
	}
	target, err := safeJoin(root, op[1])
	if err != nil {
		return err
	}
	data, err := os.ReadFile(filepath.Join(s.uploads(), op[2]))
	if err != nil {
		return &protoError{code: "BAD_REQUEST", msg: "staged upload is missing"}
	}
	mode := os.FileMode(0o644)
	if len(op) == 4 {
		switch op[3] {
		case "644":
		case "755":
			mode = 0o755
		default:
			return &protoError{code: "BAD_REQUEST", msg: "bad mode " + op[3]}
		}
	}
	return writeFileReplacing(root, target, data, mode)
}

// withView は id の時点のツリーを読み取り専用で mount し、fn を呼んでから unmount する。
func (s *store) withView(id string, fn func(root string) error) error {
	if _, ok := s.layers[id]; !ok {
		return &protoError{code: "UNKNOWN_LAYER", msg: "unknown layer " + id}
	}
	data := fmt.Sprintf("lowerdir=%s,%s", strings.Join(s.lowerdirs(id), ":"), overlayOpts)
	if err := checkOptions(data); err != nil {
		return err
	}
	if err := syscall.Mount("overlay", s.mnt(), "overlay", syscall.MS_RDONLY, data); err != nil {
		return fmt.Errorf("mount view: %w", err)
	}
	err := fn(s.mnt())
	if uerr := syscall.Unmount(s.mnt(), 0); uerr != nil && err == nil {
		err = fmt.Errorf("unmount view: %w", uerr)
	}
	return err
}

func (s *store) view(id string) ([]string, error) {
	var entries []string
	err := s.withView(id, func(root string) error {
		var err error
		entries, err = dump(root)
		return err
	})
	return entries, err
}

type fileData struct {
	Path string `json:"path"`
	Data string `json:"data"` // base64
}

// readMany は id の時点のファイルの中身を base64 で返す。合計が maxReadBytes を超えたら TOO_LARGE。
// ホストは TOO_LARGE を受けたら、パスを分けて頼み直す。
func (s *store) readMany(id string, paths []string) ([]fileData, error) {
	var out []fileData
	err := s.withView(id, func(root string) error {
		total := 0
		for _, rel := range paths {
			p, err := safeJoin(root, rel)
			if err != nil {
				return err
			}
			st, err := os.Lstat(p)
			if err != nil {
				return err
			}
			if !st.Mode().IsRegular() {
				return &protoError{code: "EINVAL", msg: rel + " is not a regular file"}
			}
			total += int(st.Size())
			if total > maxReadBytes {
				return &protoError{code: "TOO_LARGE", msg: fmt.Sprintf("total exceeds %d bytes", maxReadBytes)}
			}
			b, err := os.ReadFile(p)
			if err != nil {
				return err
			}
			out = append(out, fileData{Path: rel, Data: base64.StdEncoding.EncodeToString(b)})
		}
		return nil
	})
	return out, err
}

// readChunk は、大きい応答が止まる macOS の virtio-console 向けに、1 ファイルを小分けで返す。
func (s *store) readChunk(id, rel string, offset int64, limit int) (string, bool, error) {
	if offset < 0 || limit <= 0 || limit > maxChunkBytes {
		return "", false, &protoError{code: "BAD_REQUEST", msg: fmt.Sprintf("readChunk limit must be 1..%d", maxChunkBytes)}
	}
	var encoded string
	var done bool
	err := s.withView(id, func(root string) error {
		p, err := safeJoin(root, rel)
		if err != nil {
			return err
		}
		st, err := os.Lstat(p)
		if err != nil {
			return err
		}
		if !st.Mode().IsRegular() {
			return &protoError{code: "EINVAL", msg: rel + " is not a regular file"}
		}
		if offset > st.Size() {
			return &protoError{code: "BAD_REQUEST", msg: "readChunk offset is past EOF"}
		}
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		defer f.Close()
		buf := make([]byte, limit)
		n, err := f.ReadAt(buf, offset)
		if err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		encoded = base64.StdEncoding.EncodeToString(buf[:n])
		done = offset+int64(n) >= st.Size()
		return nil
	})
	return encoded, done, err
}

// inspect は層そのもの（凍結した upper）の中身を、OverlayFS の表現が分かる形で返す。
//
//	w  whiteout（種類 0,0 のキャラクタデバイス）
//	O  opaque ディレクトリ（user.overlay.opaque=y。下の層の中身を隠す）
//	r  redirect の付いたディレクトリ（user.overlay.redirect。redirect_dir=nofollow では作られない）
//	d  ディレクトリ、f  ファイル、l  シンボリックリンク、o  その他
//
// ゴールデンテストはマージ済みのビューしか比べないので、層の表現はこれで確かめる（#12）。
func (s *store) inspect(id string) ([]string, error) {
	l, ok := s.layers[id]
	if !ok {
		return nil, &protoError{code: "UNKNOWN_LAYER", msg: "unknown layer " + id}
	}
	root := s.abs(l.dir)
	var lines []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == root {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		st, err := os.Lstat(p)
		if err != nil {
			return err
		}
		mode := st.Mode()
		switch {
		case mode&os.ModeCharDevice != 0:
			if sys, ok := st.Sys().(*syscall.Stat_t); ok && sys.Rdev == 0 {
				lines = append(lines, "w\t"+rel)
			} else {
				lines = append(lines, "o\t"+rel)
			}
		case mode.IsDir():
			kind := "d"
			if xattrValue(p, "user.overlay.opaque") == "y" {
				kind = "O"
			}
			line := kind + "\t" + rel
			if r := xattrValue(p, "user.overlay.redirect"); r != "" {
				line = "r\t" + rel + "\t" + r
			}
			lines = append(lines, line)
		case mode&os.ModeSymlink != 0:
			lines = append(lines, "l\t"+rel)
		case mode.IsRegular():
			lines = append(lines, "f\t"+rel)
		default:
			lines = append(lines, "o\t"+rel)
		}
		return nil
	})
	sort.Slice(lines, func(i, j int) bool { return field(lines[i], 1) < field(lines[j], 1) })
	return lines, err
}

func field(line string, i int) string {
	parts := strings.Split(line, "\t")
	if i < len(parts) {
		return parts[i]
	}
	return ""
}

func xattrValue(p, name string) string {
	buf := make([]byte, 256)
	n, err := syscall.Getxattr(p, name, buf)
	if err != nil || n <= 0 {
		return ""
	}
	return string(buf[:n])
}

// safeJoin はシナリオの相対パスを mount 先の絶対パスにする。外へ出るパスは拒否する。
func safeJoin(root, rel string) (string, error) {
	if rel == "" || strings.HasPrefix(rel, "/") {
		return "", &protoError{code: "BAD_PATH", msg: fmt.Sprintf("bad path %q", rel)}
	}
	for _, seg := range strings.Split(rel, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return "", &protoError{code: "BAD_PATH", msg: fmt.Sprintf("bad path %q", rel)}
		}
	}
	return filepath.Join(root, filepath.FromSlash(rel)), nil
}

func opSummary(op []string) string {
	if len(op) >= 2 {
		return op[0] + " " + op[1]
	}
	return strings.Join(op, " ")
}

// applyOp は op を 1 つ当てる。戻り値の int は、rename が EXDEV になってコピーで代わりにやった回数。
//
//	["write", path, text]              テキストを書く（ゴールデンテストのシナリオ用）
//	["writeb64", path, base64, mode?]  中身を base64 で渡して書く。mode は "644" / "755"（省略時 644）
//	["rm", path]                       ファイルを消す
//	["rmdir", path]                    ディレクトリを中身ごと消す
//	["mkdir", path]                    ディレクトリを作る
//	["mv", from, to]                   名前を変える（下の層のディレクトリは EXDEV → コピーして消す）
//
// write / writeb64 は、置き先にディレクトリがあれば中身ごと消してからファイルを置き、途中に
// ファイルがあれば消してディレクトリにする。Git のツリーでは同じパスがファイルとディレクトリを
// 同時に取らないので、ホストが「消す op」を先に並べれば起きないが、順番に依存しないようにする。
func applyOp(root string, op []string) (int, error) {
	if len(op) == 0 {
		return 0, &protoError{code: "BAD_REQUEST", msg: "empty op"}
	}
	arity := map[string][2]int{
		"write": {3, 3}, "writeb64": {3, 4}, "rm": {2, 2}, "rmdir": {2, 2}, "mkdir": {2, 2}, "mv": {3, 3},
	}[op[0]]
	if arity[0] == 0 || len(op) < arity[0] || len(op) > arity[1] {
		return 0, &protoError{code: "BAD_REQUEST", msg: fmt.Sprintf("bad op %v", opSummary(op))}
	}
	a, err := safeJoin(root, op[1])
	if err != nil {
		return 0, err
	}
	switch op[0] {
	case "write":
		return 0, writeFileReplacing(root, a, []byte(op[2]), 0o644)
	case "writeb64":
		b, err := base64.StdEncoding.DecodeString(op[2])
		if err != nil {
			return 0, &protoError{code: "BAD_REQUEST", msg: "bad base64 for " + op[1]}
		}
		mode := os.FileMode(0o644)
		if len(op) == 4 {
			m, err := strconv.ParseUint(op[3], 8, 32)
			if err != nil || (m != 0o644 && m != 0o755) {
				return 0, &protoError{code: "BAD_REQUEST", msg: "mode must be 644 or 755"}
			}
			mode = os.FileMode(m)
		}
		return 0, writeFileReplacing(root, a, b, mode)
	case "rm":
		return 0, syscall.Unlink(a)
	case "rmdir":
		return 0, os.RemoveAll(a)
	case "mkdir":
		return 0, os.MkdirAll(a, 0o755)
	case "mv":
		b, err := safeJoin(root, op[2])
		if err != nil {
			return 0, err
		}
		if err := os.MkdirAll(filepath.Dir(b), 0o755); err != nil {
			return 0, err
		}
		err = os.Rename(a, b)
		if errors.Is(err, syscall.EXDEV) {
			// redirect_dir=nofollow では、下の層にあるディレクトリの rename は EXDEV になる。
			// coreutils の mv と同じく、コピーして元を消す（record-kernel.mjs は mv を使っている）
			if err := copyTree(a, b); err != nil {
				return 0, err
			}
			return 1, os.RemoveAll(a)
		}
		return 0, err
	}
	return 0, nil
}

// writeFileReplacing は p にファイルを書く。途中のパスにファイルがあれば消し、p にディレクトリがあれば中身ごと消す。
func writeFileReplacing(root, p string, data []byte, mode os.FileMode) error {
	rel, err := filepath.Rel(root, filepath.Dir(p))
	if err != nil {
		return err
	}
	cur := root
	if rel != "." {
		for _, part := range strings.Split(rel, string(filepath.Separator)) {
			cur = filepath.Join(cur, part)
			st, err := os.Lstat(cur)
			if err == nil && st.IsDir() {
				continue
			}
			if err == nil {
				if err := os.Remove(cur); err != nil {
					return err
				}
			}
			if err := os.Mkdir(cur, 0o755); err != nil {
				return err
			}
		}
	}
	if st, err := os.Lstat(p); err == nil && st.IsDir() {
		if err := os.RemoveAll(p); err != nil {
			return err
		}
	}
	if err := os.WriteFile(p, data, mode); err != nil {
		return err
	}
	// 既存のファイルを上書きしたとき、WriteFile は mode を変えない
	return os.Chmod(p, mode)
}

func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		to := filepath.Join(dst, rel)
		switch {
		case d.Type()&fs.ModeSymlink != 0:
			target, err := os.Readlink(p)
			if err != nil {
				return err
			}
			return os.Symlink(target, to)
		case d.IsDir():
			return os.MkdirAll(to, 0o755)
		default:
			info, err := d.Info()
			if err != nil {
				return err
			}
			in, err := os.Open(p)
			if err != nil {
				return err
			}
			defer in.Close()
			out, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, info.Mode().Perm())
			if err != nil {
				return err
			}
			if _, err := io.Copy(out, in); err != nil {
				out.Close()
				return err
			}
			return out.Close()
		}
	})
}

// dump は record-kernel.mjs の dump と同じ形式でツリーを列挙する。
// 1 行 1 エントリ: 種別<TAB>パス[<TAB>詳細]。パスのバイト順（LC_ALL=C sort と同じ）。
func dump(root string) ([]string, error) {
	type entry struct{ path, line string }
	var entries []entry
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == root {
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		var line string
		switch t := d.Type(); {
		case t&fs.ModeSymlink != 0:
			target, err := os.Readlink(p)
			if err != nil {
				return err
			}
			line = "l\t" + rel + "\t" + target
		case d.IsDir():
			line = "d\t" + rel
		case t.IsRegular():
			sum, err := sha256File(p)
			if err != nil {
				return err
			}
			line = "f\t" + rel + "\t" + sum
		default:
			line = "o\t" + rel
		}
		entries = append(entries, entry{rel, line})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].path < entries[j].path })
	lines := make([]string, len(entries))
	for i, e := range entries {
		lines[i] = e.line
	}
	return lines, nil
}

func sha256File(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// currentMountOptions は /proc/mounts から mountpoint の overlay のオプションを、パスを除いて返す。
func currentMountOptions(mountpoint string) string {
	b, err := os.ReadFile("/proc/mounts")
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) < 4 || f[1] != mountpoint || f[2] != "overlay" {
			continue
		}
		var keep []string
		for _, o := range strings.Split(f[3], ",") {
			if strings.HasPrefix(o, "lowerdir=") || strings.HasPrefix(o, "upperdir=") || strings.HasPrefix(o, "workdir=") {
				continue
			}
			keep = append(keep, o)
		}
		return strings.Join(keep, ",")
	}
	return ""
}

// stats は層の数と、層の置き場所のファイルシステムの使用量を返す。
func (s *store) stats() (layers int, usedBytes, totalBytes uint64) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(s.root, &st); err == nil {
		totalBytes = st.Blocks * uint64(st.Bsize)
		usedBytes = (st.Blocks - st.Bfree) * uint64(st.Bsize)
	}
	return len(s.layers), usedBytes, totalBytes
}
