package main

// agent の命令の形 v1 のテスト（#12）。本物の OverlayFS を mount するので、root かユーザー名前空間の中で流す。
//   WSL2 など:        go test -c -o agent.test && unshare -Urm ./agent.test -test.v
//   GitHub Actions:   go test -c -o agent.test && sudo ./agent.test -test.v   （非特権の名前空間が止められているため）
// mount できない環境では Skip する。

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"
)

// client は serveStream を相手に、パイプ越しに命令を送る。ホストと同じ道を通す。
type client struct {
	t   *testing.T
	st  *store // serveStream が相手にしている store。要求を処理していない間だけ、外から読み取りに使う
	w   io.Writer
	sc  *bufio.Scanner
	id  int
	out chan error
}

func newClient(t *testing.T) *client {
	t.Helper()
	root := t.TempDir()
	s, err := newStore(root)
	if err != nil {
		t.Fatal(err)
	}
	// mount できるか先に試す。できなければ Skip（root でもユーザー名前空間の中でもない）
	if _, err := s.commit("probe", "", nil); err != nil {
		t.Skipf("OverlayFS を mount できない環境: %v", err)
	}
	if err := s.reset(); err != nil {
		t.Fatal(err)
	}
	reqR, reqW := io.Pipe()
	resR, resW := io.Pipe()
	c := &client{t: t, st: s, w: reqW, sc: bufio.NewScanner(resR), out: make(chan error, 1)}
	c.sc.Buffer(make([]byte, 64*1024), maxRequestBytes)
	go func() { c.out <- serveStream(reqR, resW, s, func() {}); resW.Close() }()
	t.Cleanup(func() { reqW.Close(); <-c.out; _ = s.reset() })
	ready := c.read()
	if ready.Event != "ready" || ready.Protocol != protocolVersion {
		t.Fatalf("ready = %+v", ready)
	}
	return c
}

func (c *client) read() response {
	c.t.Helper()
	if !c.sc.Scan() {
		c.t.Fatalf("no response: %v", c.sc.Err())
	}
	var res response
	if err := json.Unmarshal(c.sc.Bytes(), &res); err != nil {
		c.t.Fatal(err)
	}
	return res
}

func (c *client) do(req map[string]any) response {
	c.t.Helper()
	c.id++
	req["id"] = c.id
	b, _ := json.Marshal(req)
	if _, err := c.w.Write(append(b, '\n')); err != nil {
		c.t.Fatal(err)
	}
	res := c.read()
	if res.ID != c.id {
		c.t.Fatalf("id %d, want %d", res.ID, c.id)
	}
	return res
}

func (c *client) ok(req map[string]any) response {
	c.t.Helper()
	res := c.do(req)
	if !res.OK {
		c.t.Fatalf("%v failed: %s (%s)", req["op"], res.Error, res.Code)
	}
	return res
}

func (c *client) commit(layer, parent string, ops ...[]string) response {
	c.t.Helper()
	return c.ok(map[string]any{"op": "commit", "layer": layer, "parent": parent, "ops": ops})
}

func (c *client) paths(layer string) string {
	c.t.Helper()
	var out []string
	for _, e := range c.ok(map[string]any{"op": "view", "layer": layer}).Entries {
		parts := strings.Split(e, "\t")
		out = append(out, parts[0]+" "+parts[1])
	}
	return strings.Join(out, ",")
}

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func TestHelloReportsProtocolAndFixedOptions(t *testing.T) {
	c := newClient(t)
	res := c.ok(map[string]any{"op": "hello"})
	if res.Protocol != 1 || res.Agent != agentVersion || res.MountOptions != overlayOpts {
		t.Fatalf("hello = %+v", res)
	}
}

func TestCommitViewAndDepth(t *testing.T) {
	c := newClient(t)
	r := c.commit("c1", "", []string{"write", "a.txt", "A"}, []string{"write", "d/b.txt", "B"})
	if r.Depth != 1 || r.Existed {
		t.Fatalf("c1 = %+v", r)
	}
	r = c.commit("c2", "c1", []string{"rm", "a.txt"})
	if r.Depth != 2 {
		t.Fatalf("c2 depth = %d", r.Depth)
	}
	if got := c.paths("c1"); got != "f a.txt,d d,f d/b.txt" {
		t.Fatalf("view c1 = %s", got)
	}
	if got := c.paths("c2"); got != "d d,f d/b.txt" {
		t.Fatalf("view c2 = %s", got)
	}
}

func TestCommitIsIdempotentButRejectsDifferentParent(t *testing.T) {
	c := newClient(t)
	c.commit("c1", "")
	c.commit("c2", "c1", []string{"write", "x", "1"})
	r := c.commit("c2", "c1", []string{"write", "x", "different"})
	if !r.Existed || r.Depth != 2 {
		t.Fatalf("re-commit = %+v", r)
	}
	// 中身は最初のまま（作り直さない）
	data := c.ok(map[string]any{"op": "read", "layer": "c2", "path": "x"}).Data
	if data == nil || *data != b64("1") {
		t.Fatalf("read x = %v", data)
	}
	res := c.do(map[string]any{"op": "commit", "layer": "c2", "parent": "", "ops": [][]string{}})
	if res.OK || res.Code != "EEXIST" {
		t.Fatalf("different parent = %+v", res)
	}
}

func TestErrorsCarryCodes(t *testing.T) {
	c := newClient(t)
	cases := []struct {
		req  map[string]any
		code string
	}{
		{map[string]any{"op": "commit", "layer": "x", "parent": "missing"}, "UNKNOWN_LAYER"},
		{map[string]any{"op": "view", "layer": "missing"}, "UNKNOWN_LAYER"},
		{map[string]any{"op": "commit", "layer": "", "parent": ""}, "BAD_REQUEST"},
		{map[string]any{"op": "commit", "layer": "p", "parent": "", "ops": [][]string{{"write", "../escape", "x"}}}, "BAD_PATH"},
		{map[string]any{"op": "commit", "layer": "q", "parent": "", "ops": [][]string{{"rm", "nothing"}}}, "ENOENT"},
		{map[string]any{"op": "commit", "layer": "r", "parent": "", "ops": [][]string{{"writeb64", "a", "!!!"}}}, "BAD_REQUEST"},
		{map[string]any{"op": "commit", "layer": "s", "parent": "", "ops": [][]string{{"writeb64", "a", b64("x"), "777"}}}, "BAD_REQUEST"},
		{map[string]any{"op": "nope"}, "BAD_REQUEST"},
	}
	for _, tc := range cases {
		res := c.do(tc.req)
		if res.OK || res.Code != tc.code {
			t.Errorf("%v: got ok=%v code=%q error=%q, want %s", tc.req, res.OK, res.Code, res.Error, tc.code)
		}
	}
	// 失敗したコミットは層を残さない
	if res := c.do(map[string]any{"op": "view", "layer": "q"}); res.Code != "UNKNOWN_LAYER" {
		t.Fatalf("failed commit left a layer: %+v", res)
	}
}

func TestBinaryContentModeAndReadMany(t *testing.T) {
	c := newClient(t)
	bin := string([]byte{0, 1, 2, 255, '\n', 0})
	c.commit("c1", "", []string{"writeb64", "bin.dat", b64(bin)}, []string{"writeb64", "run.sh", b64("#!/bin/sh\n"), "755"}, []string{"writeb64", "日本語/メモ.txt", b64("メモ")})
	files := c.ok(map[string]any{"op": "readMany", "layer": "c1", "paths": []string{"bin.dat", "日本語/メモ.txt"}}).Files
	if len(files) != 2 || files[0].Data != b64(bin) || files[1].Path != "日本語/メモ.txt" || files[1].Data != b64("メモ") {
		t.Fatalf("readMany = %+v", files)
	}
	err := c.st.withView("c1", func(root string) error {
		st, err := os.Stat(root + "/run.sh")
		if err != nil {
			return err
		}
		if st.Mode().Perm() != 0o755 {
			t.Errorf("run.sh mode = %v", st.Mode())
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// 読めないもの（ディレクトリ）
	if res := c.do(map[string]any{"op": "read", "layer": "c1", "path": "日本語"}); res.Code != "EINVAL" {
		t.Fatalf("read dir = %+v", res)
	}
}

func TestChunkedStageAndRead(t *testing.T) {
	c := newClient(t)
	part1 := []byte("first-")
	part2 := []byte("second")
	c.ok(map[string]any{"op": "stage", "upload": "u-1", "data": b64(string(part1))})
	c.ok(map[string]any{"op": "stage", "upload": "u-1", "data": b64(string(part2)), "append": true})
	c.ok(map[string]any{"op": "stageOp", "upload": "ops-c1", "stagedOp": []string{"writeupload", "large.bin", "u-1", "755"}})
	c.ok(map[string]any{"op": "commit", "layer": "c1", "opsUpload": "ops-c1"})

	first := c.ok(map[string]any{"op": "readChunk", "layer": "c1", "path": "large.bin", "offset": 0, "limit": 5})
	second := c.ok(map[string]any{"op": "readChunk", "layer": "c1", "path": "large.bin", "offset": 5, "limit": 32})
	if first.Data == nil || second.Data == nil {
		t.Fatal("readChunk data is missing")
	}
	a, _ := base64.StdEncoding.DecodeString(*first.Data)
	b, _ := base64.StdEncoding.DecodeString(*second.Data)
	if string(append(a, b...)) != "first-second" || first.Done || !second.Done {
		t.Fatalf("chunked read = %q / %+v %+v", append(a, b...), first, second)
	}
}

func TestWriteReplacesDirectoryAndFileInTheWay(t *testing.T) {
	c := newClient(t)
	c.commit("c1", "", []string{"write", "p/q.txt", "Q"}, []string{"write", "f", "file"})
	// p（ディレクトリ）をファイルに、f（ファイル）をディレクトリに。消す op を並べずに書いても置き換わる
	c.commit("c2", "c1", []string{"write", "p", "now a file"}, []string{"write", "f/inner.txt", "I"})
	if got := c.paths("c2"); got != "d f,f f/inner.txt,f p" {
		t.Fatalf("view c2 = %s", got)
	}
}

func TestInspectShowsWhiteoutOpaqueAndNoRedirect(t *testing.T) {
	c := newClient(t)
	c.commit("c1", "", []string{"write", "a.txt", "A"}, []string{"write", "d/x", "X"}, []string{"write", "e/y", "Y"})
	r := c.commit("c2", "c1", []string{"rm", "a.txt"}, []string{"rmdir", "d"}, []string{"write", "d/z", "Z"}, []string{"mv", "e", "e2"})
	if r.ExdevRenames != 1 {
		t.Fatalf("exdevRenames = %d", r.ExdevRenames)
	}
	got := strings.Join(c.ok(map[string]any{"op": "inspect", "layer": "c2"}).Entries, ",")
	// a.txt は whiteout、d は作り直したので opaque、e は rename がコピーになったので whiteout と新しい e2
	want := "w\ta.txt,O\td,f\td/z,w\te,d\te2,f\te2/y"
	if got != want {
		t.Fatalf("inspect c2 =\n  %q\nwant\n  %q", got, want)
	}
}

func TestDeepChainBeyondHostLimit(t *testing.T) {
	c := newClient(t)
	parent := ""
	for i := 0; i < 40; i++ {
		id := "c" + string(rune('A'+i%26)) + strings.Repeat("x", i/26)
		r := c.commit(id, parent, []string{"write", "n.txt", id})
		if r.Depth != i+1 {
			t.Fatalf("depth = %d at %d", r.Depth, i)
		}
		parent = id
	}
	if got := c.paths(parent); !strings.HasPrefix(got, "f n.txt") {
		t.Fatalf("view = %s", got)
	}
	st := c.ok(map[string]any{"op": "stats"})
	if st.Layers == nil || *st.Layers != 40 {
		t.Fatalf("stats = %+v", st)
	}
}
