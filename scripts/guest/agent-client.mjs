/**
 * 最小ゲストの agent（guest/agent）と話すための部品。
 * stdin/stdout が agent の命令の通り道になっているコマンド（QEMU、mac/microgit-vm、unshare -Urm <agent>）を起動して使う。
 *
 * 命令は 1 行 1 JSON。`id` を付けて送ると、agent は同じ `id` で答える。
 * ゲストの準備ができると agent が {"event":"ready"} を送ってくるので、それまで待つ。
 */
import { spawn } from 'child_process';
import readline from 'readline';

export class AgentClient {
    /**
     * @param {string} cmd 起動するコマンド
     * @param {string[]} args 引数
     * @param {{ bootTimeoutMs?: number, requestTimeoutMs?: number }} [opts]
     */
    constructor(cmd, args, opts = {}) {
        this.bootTimeoutMs = opts.bootTimeoutMs ?? 120000;
        this.requestTimeoutMs = opts.requestTimeoutMs ?? 30000;
        this.child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] });
        this.nextId = 1;
        this.pending = new Map();
        this.readyWaiters = [];
        this.ready = undefined;
        this.exited = false;
        this.startError = undefined;
        this.child.on('error', (e) => { this.startError = e; this.fail(e); });
        readline.createInterface({ input: this.child.stdout }).on('line', (line) => this.onLine(line));
        this.child.on('exit', (code, signal) => {
            this.exited = true;
            this.fail(new Error(`agent process exited (code=${code} signal=${signal})`));
        });
    }

    fail(err) {
        for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(err); }
        this.pending.clear();
        for (const w of this.readyWaiters) { w.reject(err); }
        this.readyWaiters = [];
    }

    onLine(line) {
        let msg;
        try {
            msg = JSON.parse(line);
        } catch {
            // ゲストの起動前に QEMU などが出す文字は無視する
            return;
        }
        if (msg.event === 'ready') {
            this.ready = msg;
            for (const w of this.readyWaiters) { w.resolve(msg); }
            this.readyWaiters = [];
            return;
        }
        const p = this.pending.get(msg.id);
        if (!p) { return; }
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
    }

    /** agent の {"event":"ready"} を待つ */
    waitReady() {
        if (this.ready) { return Promise.resolve(this.ready); }
        if (this.startError) { return Promise.reject(this.startError); }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`agent not ready within ${this.bootTimeoutMs} ms`)), this.bootTimeoutMs);
            this.readyWaiters.push({
                resolve: (m) => { clearTimeout(timer); resolve(m); },
                reject: (e) => { clearTimeout(timer); reject(e); },
            });
        });
    }

    /** 命令を 1 つ送り、応答をそのまま返す（ok が false でも例外にしない） */
    request(body) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`timeout: ${JSON.stringify(body).slice(0, 200)}`));
            }, this.requestTimeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.child.stdin.write(JSON.stringify({ id, ...body }) + '\n');
        });
    }

    /** 命令を 1 つ送り、ok でなければ例外にする */
    async call(body) {
        const res = await this.request(body);
        if (!res.ok) { throw new Error(`${body.op} failed: ${res.error}`); }
        return res;
    }

    /** 電源を切って、プロセスが終わるまで待つ（止まらなければ 15 秒で強制終了） */
    async powerOff() {
        await this.call({ op: 'poweroff' }).catch(() => { /* 応答前に止まることがある */ });
        await new Promise((resolve) => {
            if (this.exited) { return resolve(); }
            const t = setTimeout(() => { this.child.kill(); resolve(); }, 15000);
            this.child.on('exit', () => { clearTimeout(t); resolve(); });
        });
    }
}
