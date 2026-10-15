// MicroGit の最小ゲストの init 兼 agent（Issue #15, #17, #12）。
//
// カーネルは initramfs の /init としてこれを PID 1 で起動する。ゲストのユーザーランドはこの 1 ファイルだけで、
// シェルは入れない（AD-7）。PID 1 が終わるとカーネルがパニックするので、main は戻らない。
//
// ホストとは virtio-console の名前付きポート "microgit" でつながる。1 行 1 つの JSON で要求を受け、
// 1 行 1 つの JSON で答える（要求と応答は 1 対 1、順番どおり）。命令の形は docs/agent-protocol.md（v1）。
//
// PID 1 以外で起動すると、同じ命令を stdin/stdout で受ける（Linux ホストで VM を使わない経路、AD-2・#14）。
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const (
	// agentVersion は hello と ready で返す agent の版。
	agentVersion    = "1.1.0"
	// protocolVersion は命令の形（docs/agent-protocol.md）の版。ready と hello の protocol に載る。
	protocolVersion = 1
	// portName はホストとつなぐ virtio-console ポートの名前。番号ではなくこの名前で探す（findPort）。
	portName        = "microgit"
	// stateRoot は PID 1 のときに層を積む場所（tmpfs の /run の下）。reset で中身ごと消える。
	stateRoot       = "/run/microgit"
	// 1 行の要求の上限。writeb64 で大きなファイルを送るので大きめにする
	maxRequestBytes = 128 << 20
)

// request はホストから来る 1 行 1 つの JSON の要求。op で使う項目が決まり、
// 使わない項目は省かれる。op ごとの項目は docs/agent-protocol.md の表を参照。
type request struct {
	ID        int        `json:"id"`
	Op        string     `json:"op"`
	Layer     string     `json:"layer,omitempty"`
	Parent    string     `json:"parent,omitempty"`
	Ops       [][]string `json:"ops,omitempty"`
	OpsUpload string     `json:"opsUpload,omitempty"`
	StagedOp  []string   `json:"stagedOp,omitempty"`
	Path      string     `json:"path,omitempty"`
	Paths     []string   `json:"paths,omitempty"`
	Upload    string     `json:"upload,omitempty"`
	Data      string     `json:"data,omitempty"`
	Append    bool       `json:"append,omitempty"`
	Offset    int64      `json:"offset,omitempty"`
	Limit     int        `json:"limit,omitempty"`
}

// response は要求 1 つにつき 1 行返す JSON の応答。ok は常に出て、失敗のときだけ error と code が入る。
// 他の項目は op ごとに必要なものだけが入る（omitempty）。event "ready" は要求なしで、serveStream が接続のたびに最初の 1 行として送る。
type response struct {
	ID    int    `json:"id,omitempty"`
	Event string `json:"event,omitempty"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
	Code  string `json:"code,omitempty"`

	Protocol     int        `json:"protocol,omitempty"`
	Kernel       string     `json:"kernel,omitempty"`
	Agent        string     `json:"agent,omitempty"`
	MountOptions string     `json:"mountOptions,omitempty"`
	Layer        string     `json:"layer,omitempty"`
	Existed      bool       `json:"existed,omitempty"`
	Depth        int        `json:"depth,omitempty"`
	ExdevRenames int        `json:"exdevRenames,omitempty"`
	Entries      []string   `json:"entries,omitempty"`
	Data         *string    `json:"data,omitempty"`
	Done         bool       `json:"done,omitempty"`
	Files        []fileData `json:"files,omitempty"`
	Layers       *int       `json:"layers,omitempty"`
	UsedBytes    uint64     `json:"usedBytes,omitempty"`
	TotalBytes   uint64     `json:"totalBytes,omitempty"`
	ElapsedUs    int64      `json:"elapsedUs,omitempty"`
}

// protoError はホストが種類で分岐できるエラー。code は docs/agent-protocol.md の表の記号。
type protoError struct {
	code string
	msg  string
}

// Error は error の文面（msg）を返す。
func (e *protoError) Error() string { return e.msg }

// errorCode はエラーを記号にする。システムコールのエラーは errno の名前（ENOENT など）にする。
func errorCode(err error) string {
	var pe *protoError
	if errors.As(err, &pe) {
		return pe.code
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		if name, ok := errnoNames[errno]; ok {
			return name
		}
		return fmt.Sprintf("ERRNO_%d", int(errno))
	}
	return "EINTERNAL"
}

// errnoNames は errorCode が記号にする errno の一覧。ここに無い errno は ERRNO_<番号> になる。
var errnoNames = map[syscall.Errno]string{
	syscall.ENOENT: "ENOENT", syscall.EEXIST: "EEXIST", syscall.ENOTDIR: "ENOTDIR", syscall.EISDIR: "EISDIR",
	syscall.EXDEV: "EXDEV", syscall.ENOSPC: "ENOSPC", syscall.EACCES: "EACCES", syscall.EPERM: "EPERM",
	syscall.EINVAL: "EINVAL", syscall.ENAMETOOLONG: "ENAMETOOLONG", syscall.ENOTEMPTY: "ENOTEMPTY",
	syscall.EROFS: "EROFS", syscall.ENOMEM: "ENOMEM",
}

// logf は標準出力に "microgit-agent: " 付きで 1 行出す。
func logf(format string, args ...any) {
	fmt.Fprintf(os.Stdout, "microgit-agent: "+format+"\n", args...)
}

// main は PID 1 なら、システムを整え、ポートを開いて命令を受け続ける（戻らない）。
// PID 1 でなければ runStdio で標準入出力から受ける。
func main() {
	if os.Getpid() != 1 {
		runStdio()
		return
	}
	if err := setupSystem(); err != nil {
		fatal(err)
	}
	store, err := newStore(stateRoot)
	if err != nil {
		fatal(err)
	}
	port, err := findPort(portName, 10*time.Second)
	if err != nil {
		fatal(err)
	}
	logf("ready kernel=%s port=%s protocol=%d", kernelRelease(), port, protocolVersion)
	for {
		if err := serve(port, store); err != nil {
			logf("port error: %v", err)
		}
		// ホスト側が閉じていると EOF になる。つなぎ直しを待つ
		time.Sleep(200 * time.Millisecond)
	}
}

// fatal は致命的なエラーを記録して電源を切る。PID 1 が戻るとカーネルがパニックするため、終わるときは電源を切る。
func fatal(err error) {
	logf("fatal: %v", err)
	powerOff()
}

// powerOff はディスクを同期して VM の電源を切る。戻らない（切れるまで止まる）。
func powerOff() {
	syscall.Sync()
	// arm64 は PSCI の SYSTEM_OFF、x86_64 は ACPI で電源を切る。QEMU も Virtualization.framework も VM を止める
	_ = syscall.Reboot(syscall.LINUX_REBOOT_CMD_POWER_OFF)
	select {}
}

// setupSystem は PID 1 として、/proc・/sys・/dev・/run（tmpfs）を mount する。シェルが無いので agent 自身が行う。
// どれかが失敗したらエラーを返す（呼び出し側は fatal にする）。
func setupSystem() error {
	mounts := []struct{ src, target, fstype, data string }{
		{"proc", "/proc", "proc", ""},
		{"sysfs", "/sys", "sysfs", ""},
		{"devtmpfs", "/dev", "devtmpfs", ""},
		{"tmpfs", "/run", "tmpfs", "mode=0755"},
	}
	for _, m := range mounts {
		if err := os.MkdirAll(m.target, 0o755); err != nil {
			return err
		}
		if err := syscall.Mount(m.src, m.target, m.fstype, 0, m.data); err != nil {
			return fmt.Errorf("mount %s: %w", m.target, err)
		}
	}
	return nil
}

// findPort は名前が一致する virtio-console ポートのデバイスパスを返す。
// QEMU では /dev/vport0p1、Virtualization.framework では /dev/vport1p0 のように番号が環境で変わるため、名前で探す。
func findPort(name string, timeout time.Duration) (string, error) {
	deadline := time.Now().Add(timeout)
	for {
		names, _ := filepath.Glob("/sys/class/virtio-ports/*/name")
		for _, n := range names {
			b, err := os.ReadFile(n)
			if err == nil && strings.TrimSpace(string(b)) == name {
				return "/dev/" + filepath.Base(filepath.Dir(n)), nil
			}
		}
		if time.Now().After(deadline) {
			return "", fmt.Errorf("virtio-console port %q not found", name)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// kernelRelease は uname のカーネルのリリース文字列を返す。取れなければ "unknown"。hello と起動ログに載る。
func kernelRelease() string {
	var u syscall.Utsname
	if err := syscall.Uname(&u); err != nil {
		return "unknown"
	}
	var b strings.Builder
	for _, c := range u.Release {
		if c == 0 {
			break
		}
		b.WriteByte(byte(c))
	}
	return b.String()
}

// runStdio は PID 1 以外で起動されたときの動き。VM を使わずに、同じ命令を stdin/stdout で受ける。
// Linux ホストでは `unshare -Urm <agent>` で非特権のまま OverlayFS を使える（AD-2 のネイティブ経路）。
// 層は MICROGIT_AGENT_STATE_DIR（無ければ一時ディレクトリ）の下に置き、poweroff か stdin の終わりで片付ける。
func runStdio() {
	parent := os.Getenv("MICROGIT_AGENT_STATE_DIR")
	if parent != "" {
		if err := os.MkdirAll(parent, 0o700); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	root, err := os.MkdirTemp(parent, "microgit-agent-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	s, err := newStore(root)
	if err == nil {
		err = serveStream(os.Stdin, os.Stdout, s, func() {})
	}
	_ = s.reset()
	_ = os.RemoveAll(root)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// serve はポートのデバイスを開き、閉じるまで serveStream で命令を受ける。poweroff を受けたら powerOff を呼ぶ。
func serve(port string, store *store) error {
	f, err := os.OpenFile(port, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	return serveStream(f, f, store, powerOff)
}

// hello は hello の応答（起動時の ready の元でもある）を作る。protocol・agent の版・固定の mount オプションを載せる。
func hello() response {
	return response{OK: true, Protocol: protocolVersion, Kernel: kernelRelease(), Agent: agentVersion, MountOptions: overlayOpts}
}

// serveStream は 1 行 1 JSON の要求を読み、応答を返す。poweroff を受けたら応答してから onPowerOff を呼んで戻る。
func serveStream(r io.Reader, w io.Writer, store *store, onPowerOff func()) error {
	enc := json.NewEncoder(w)
	ready := hello()
	ready.Event = "ready"
	if err := enc.Encode(ready); err != nil {
		return err
	}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), maxRequestBytes)
	for sc.Scan() {
		var req request
		var res response
		start := time.Now()
		if err := json.Unmarshal(sc.Bytes(), &req); err != nil {
			res = response{Error: "bad request: " + err.Error(), Code: "BAD_REQUEST"}
		} else {
			res = handle(store, req)
			res.ID = req.ID
		}
		res.ElapsedUs = time.Since(start).Microseconds()
		if err := enc.Encode(res); err != nil {
			return err
		}
		if req.Op == "poweroff" {
			onPowerOff()
			return nil
		}
	}
	if err := sc.Err(); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}

// fail はエラーを、種類の記号（errorCode）付きの失敗の応答にする。
func fail(err error) response {
	return response{Error: err.Error(), Code: errorCode(err)}
}

// handle は 1 つの要求を op で振り分けて store に渡し、応答を返す。失敗は応答の error と code にする（戻り値は常に応答）。
// 知らない op は BAD_REQUEST。poweroff の電源を切る動きは serveStream が応答の後に行う。
func handle(s *store, req request) response {
	switch req.Op {
	case "hello":
		return hello()
	case "reset":
		if err := s.reset(); err != nil {
			return fail(err)
		}
		return response{OK: true}
	case "stage":
		if err := s.stage(req.Upload, req.Data, req.Append); err != nil {
			return fail(err)
		}
		return response{OK: true}
	case "stageOp":
		if err := s.stageOp(req.Upload, req.StagedOp, req.Append); err != nil {
			return fail(err)
		}
		return response{OK: true}
	case "commit":
		ops, err := s.resolveOps(req.Ops, req.OpsUpload)
		if err != nil {
			return fail(err)
		}
		info, err := s.commit(req.Layer, req.Parent, ops)
		if err != nil {
			return fail(err)
		}
		return response{OK: true, Layer: req.Layer, Existed: info.existed, Depth: info.depth, MountOptions: info.mountOptions, ExdevRenames: info.exdevRenames}
	case "view":
		entries, err := s.view(req.Layer)
		if err != nil {
			return fail(err)
		}
		// 空のツリーでは entries が省かれる（omitempty）。ホストは entries が無ければ空として扱う
		return response{OK: true, Layer: req.Layer, Entries: entries}
	case "read":
		files, err := s.readMany(req.Layer, []string{req.Path})
		if err != nil {
			return fail(err)
		}
		return response{OK: true, Layer: req.Layer, Data: &files[0].Data}
	case "readMany":
		files, err := s.readMany(req.Layer, req.Paths)
		if err != nil {
			return fail(err)
		}
		return response{OK: true, Layer: req.Layer, Files: files}
	case "readChunk":
		data, done, err := s.readChunk(req.Layer, req.Path, req.Offset, req.Limit)
		if err != nil {
			return fail(err)
		}
		return response{OK: true, Layer: req.Layer, Data: &data, Done: done}
	case "inspect":
		entries, err := s.inspect(req.Layer)
		if err != nil {
			return fail(err)
		}
		return response{OK: true, Layer: req.Layer, Entries: entries}
	case "stats":
		n, used, total := s.stats()
		return response{OK: true, Layers: &n, UsedBytes: used, TotalBytes: total}
	case "poweroff":
		return response{OK: true}
	default:
		return response{Error: "unknown op: " + req.Op, Code: "BAD_REQUEST"}
	}
}
