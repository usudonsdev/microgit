/**
 * 構造を理解した差分（docs/structured-diff.md）の型。VS Code に依存しない。
 *
 * 前提（docs/structured-diff.md §1・§4）：
 * - 正本は shadow の Git に保存したバイト列のまま。差分は見るときに計算する派生物で、ここの型はその結果（JSON にして返す・キャッシュする）。
 * - 差分ドライバは形式ごと。入力は旧版・新版のバイト列（無ければ追加・削除）。出力は「変更の一覧」。
 * - 信頼できないファイルを読むので、ドライバは DiffLimits を守る（展開後の大きさ、要素の数、時間）。計算は別プロセス（worker.ts）で行う。
 * - 結果の JSON は Webview（diffView.ts）が描く。文字列は HTML としてではなく textContent で入れる前提（ここでエスケープしない）。
 */

/** ドライバが守る上限。超えたら DiffLimitError を投げるか、途中までの結果に truncated を付ける */
export interface DiffLimits {
    /** ZIP などを展開したあとの合計の上限（バイト） */
    maxUncompressedBytes: number;
    /** ZIP の項目の数の上限 */
    maxZipEntries: number;
    /** 表のセルの数の上限（両方の版の合計） */
    maxCells: number;
    /** 結果に入れる変更の数の上限（超えたら truncated） */
    maxChanges: number;
    /** 画像の画素の数の上限（幅 × 高さ） */
    maxPixels: number;
    /** 動画の比較に使うフレームの数の上限（両方の版それぞれ） */
    maxVideoFrames: number;
    /** 音声を復号する長さの上限（秒）。8 kHz・16 ビットで 1 時間 = 約 58 MB */
    maxMediaSeconds: number;
}

export const DEFAULT_LIMITS: DiffLimits = {
    maxUncompressedBytes: 512 * 1024 * 1024,
    maxZipEntries: 20_000,
    maxCells: 2_000_000,
    maxChanges: 5_000,
    maxPixels: 80_000_000,
    maxVideoFrames: 200_000,
    maxMediaSeconds: 4 * 3600,
};

/** 上限を超えた（ZIP 爆弾、巨大な表など）。呼ぶ側は「大きすぎて比べられない」として表示する */
export class DiffLimitError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DiffLimitError';
    }
}

/** 形式が壊れている・読めない */
export class DiffFormatError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DiffFormatError';
    }
}

/** ドライバに渡す入力。oldBytes が無ければ追加、newBytes が無ければ削除 */
export interface DiffInput {
    /** ワークスペースからの相対パス（/ 区切り）。拡張子でドライバを選ぶ */
    path: string;
    oldBytes?: Buffer;
    newBytes?: Buffer;
    /** 旧版・新版の中身を置いた一時ファイル（ffmpeg などの外部ツールに渡すため。worker.ts が作る） */
    oldFile?: string;
    newFile?: string;
}

/** 外部のツール（動画・画像の一部の形式に使う ffmpeg） */
export interface ExternalTools {
    /** ffmpeg の実行ファイル。見つからなければ undefined（動画は比べられない、と結果に書く） */
    ffmpegPath?: string;
    ffprobePath?: string;
}

export interface DiffContext {
    limits: DiffLimits;
    tools: ExternalTools;
    /** 一時ファイルを置いてよいフォルダ（worker.ts が作り、終わったら消す） */
    tmpDir: string;
}

/** 差分ドライバ。registry.ts に並べた順に matches を試す */
export interface DiffDriver {
    /** 識別子（キャッシュのキーと結果に入る） */
    id: string;
    /** 結果の形や判定を変えたら上げる（キャッシュを無効にするため） */
    version: number;
    /** 表示用の名前（例：Excel ブック） */
    label: string;
    /** このドライバで扱えるか。path は相対パス、head は旧版か新版の先頭（最大 4 KiB） */
    matches(path: string, head: Buffer): boolean;
    diff(input: DiffInput, ctx: DiffContext): Promise<StructuredDiff>;
}

/** 全ドライバの結果に共通の部分 */
export interface DiffBase {
    driver: string;
    driverVersion: number;
    path: string;
    /** 追加・削除・変更・変わらない（中身のバイト列は違うが、意味の上では同じ、を含む） */
    status: 'added' | 'deleted' | 'modified' | 'unchanged';
    /** 一覧に出す 1 行の要約（例：「Sheet1 の 3 セル、Sheet2 を追加」） */
    summary: string;
    /** 読めなかった部分・上限で打ち切った部分など、利用者に知らせること */
    warnings: string[];
    /** 変更の数が上限（maxChanges）を超えて打ち切った */
    truncated?: boolean;
    /** 解釈しなかった部品（ZIP の中のファイル）のうち、変わったもの。例：xl/charts/chart1.xml */
    otherParts?: PartChange[];
}

export interface PartChange {
    name: string;
    status: 'added' | 'deleted' | 'modified';
}

// ---------- 表（xlsx・csv） ----------

/** セルの中身。v は表示する値（共有文字列は中身に直す）、f は式（= を付けない）、t は型、style は書式の要約 */
export interface CellSnapshot {
    v?: string;
    f?: string;
    /** n 数値 / s 文字列 / b 真偽 / e エラー / d 日付 / str 式の文字列結果 */
    t?: string;
    style?: string;
}

export interface CellChange {
    /** 旧版の番地（A1 形式）。追加されたセルには無い */
    oldRef?: string;
    /** 新版の番地。削除されたセルには無い */
    newRef?: string;
    /**
     * value：値を直接変えた / formula：式を変えた / computed：式は同じで結果だけ変わった（参照先が変わった）/
     * style：書式だけ変わった / added：空だったセルに入れた / removed：消した
     */
    change: 'value' | 'formula' | 'computed' | 'style' | 'added' | 'removed';
    old?: CellSnapshot;
    new?: CellSnapshot;
    /** style のとき、何が変わったか（数値の書式・フォント・塗りつぶし・罫線・配置） */
    styleAspects?: string[];
}

/** 行・列の挿入と削除。at は 1 始まり。insert は新版の位置、delete は旧版の位置 */
export interface AxisOp {
    type: 'insert' | 'delete';
    at: number;
    count: number;
}

export interface SheetDiff {
    name: string;
    /** 名前を変えたとき、旧の名前 */
    oldName?: string;
    status: 'added' | 'deleted' | 'modified' | 'unchanged' | 'renamed';
    /** シートの並び（0 始まり） */
    oldIndex?: number;
    newIndex?: number;
    rowOps: AxisOp[];
    colOps: AxisOp[];
    cells: CellChange[];
    /** 結合セルの範囲の追加・削除 */
    mergesAdded?: string[];
    mergesRemoved?: string[];
    /** 新版の大きさ（表示用） */
    newRows?: number;
    newCols?: number;
    truncated?: boolean;
}

export interface TableDiff extends DiffBase {
    kind: 'table';
    sheets: SheetDiff[];
}

// ---------- 文書（docx） ----------

export interface InlinePart {
    op: 'eq' | 'ins' | 'del';
    text: string;
}

export interface BlockChange {
    /** insert：段落の追加 / delete：削除 / modify：文字の変更（inline に詳細）/ format：文字は同じで書式だけ変わった / equal：変わらない段落の並び（count 個） */
    type: 'insert' | 'delete' | 'modify' | 'format' | 'equal';
    oldIndex?: number;
    newIndex?: number;
    oldText?: string;
    newText?: string;
    inline?: InlinePart[];
    /** equal のときの段落の数 */
    count?: number;
    /** 段落の種類（見出し・表のセル・本文など） */
    blockKind?: string;
}

export interface DocumentDiff extends DiffBase {
    kind: 'document';
    blocks: BlockChange[];
}

// ---------- スライド（pptx） ----------

export interface ShapeChange {
    status: 'added' | 'deleted' | 'modified' | 'unchanged';
    name: string;
    oldText?: string;
    newText?: string;
    inline?: InlinePart[];
    /** 位置・大きさが変わった */
    moved?: boolean;
}

export interface SlideChange {
    status: 'added' | 'deleted' | 'modified' | 'unchanged' | 'moved';
    oldIndex?: number;
    newIndex?: number;
    /** スライドのタイトル（あれば） */
    title?: string;
    shapes: ShapeChange[];
    /** スライドのノート */
    notesChange?: { oldText?: string; newText?: string; inline?: InlinePart[] };
}

export interface SlidesDiff extends DiffBase {
    kind: 'slides';
    slides: SlideChange[];
}

// ---------- 画像 ----------

export interface Rect { x: number; y: number; w: number; h: number }

export interface ImageDiff extends DiffBase {
    kind: 'image';
    oldSize?: { w: number; h: number };
    newSize?: { w: number; h: number };
    /** 変わった矩形（新版の座標。大きさが違うときは空で、sizeChanged が true） */
    regions: Rect[];
    /** 変わった画素の割合（0〜1） */
    changedRatio: number;
    sizeChanged?: boolean;
    /** 表示用の縮小画像（data:image/png;base64,...）。heat は差を赤で重ねたもの */
    previews?: { old?: string; new?: string; heat?: string };
}

// ---------- 動画 ----------

export interface MediaInfo {
    durationSec: number;
    width?: number;
    height?: number;
    fps?: number;
    frames?: number;
    videoCodec?: string;
    audioCodec?: string;
    hasAudio: boolean;
}

export interface VideoSegment {
    /** equal：同じ / modified：同じ位置のコマが変わった / inserted：新版に足された / deleted：旧版から消えた */
    type: 'equal' | 'modified' | 'inserted' | 'deleted';
    /** 秒。inserted には old が無く、deleted には new が無い */
    oldStart?: number;
    oldEnd?: number;
    newStart?: number;
    newEnd?: number;
    /** コマの番号（比べたコマの列での位置。0 始まり、end は含まない） */
    oldFrames?: [number, number];
    newFrames?: [number, number];
    /** 区間の代表のコマ（data:image/png;base64,...） */
    thumbOld?: string;
    thumbNew?: string;
    /** modified のとき、差を赤で重ねたもの */
    heat?: string;
}

export interface AudioSegment {
    type: 'equal' | 'modified' | 'inserted' | 'deleted';
    oldStart?: number;
    oldEnd?: number;
    newStart?: number;
    newEnd?: number;
}

export interface VideoDiff extends DiffBase {
    kind: 'video';
    oldInfo?: MediaInfo;
    newInfo?: MediaInfo;
    /** 比べたコマの間隔（秒）。全コマなら 1 / fps */
    sampleIntervalSec: number;
    segments: VideoSegment[];
    audio?: { segments: AudioSegment[]; note?: string };
}

// ---------- テキスト・その他 ----------

/** テキストのファイル。表示は VS Code の差分エディタに任せる */
export interface TextDiff extends DiffBase {
    kind: 'text';
}

/** 解釈できないバイト列 */
export interface BinaryDiff extends DiffBase {
    kind: 'binary';
    oldSize?: number;
    newSize?: number;
}

/** 上限を超えた・壊れていたなどで比べられなかった */
export interface ErrorDiff extends DiffBase {
    kind: 'error';
    reason: 'limit' | 'format' | 'tool' | 'timeout' | 'internal';
    message: string;
}

export type StructuredDiff =
    | TableDiff
    | DocumentDiff
    | SlidesDiff
    | ImageDiff
    | VideoDiff
    | TextDiff
    | BinaryDiff
    | ErrorDiff;

/** 共通の部分を作る */
export function baseOf(driver: DiffDriver, input: DiffInput): Omit<DiffBase, 'summary'> {
    const status: DiffBase['status'] = !input.oldBytes ? 'added' : !input.newBytes ? 'deleted' : 'modified';
    return { driver: driver.id, driverVersion: driver.version, path: input.path, status, warnings: [] };
}

/** 拡張子（小文字、ドットなし） */
export function extOf(path: string): string {
    const base = path.split('/').pop() ?? '';
    const i = base.lastIndexOf('.');
    return i < 0 ? '' : base.slice(i + 1).toLowerCase();
}
