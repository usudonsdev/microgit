// MicroGit の最小ゲストを Virtualization.framework で起動する（Issue #17、Phase 1 の macOS バックエンド）。
//
// 使い方: microgit-vm --kernel <Image> [--initrd <initramfs>] [--console <ログの書き出し先>] [--memory-mb 256] [--cmdline "console=hvc0"]
//
// ゲストの virtio-console の名前付きポート "microgit" を、このプロセスの stdin/stdout につなぐ。
// 命令の形は guest/agent/main.go を参照（1 行 1 JSON）。stdout には命令の応答しか出さない。
// カーネルのログ（hvc0）は --console のファイルへ、省略時は stderr へ出す。
//
// macOS 13 以降、Apple シリコン。com.apple.security.virtualization の entitlement 付きで署名する（mac/build.sh）。
import Foundation
import Virtualization

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(2)
}

var kernelPath: String?
var initrdPath: String?
var consolePath: String?
var memoryMB: UInt64 = 256
var commandLine = "console=hvc0"

var args = CommandLine.arguments.dropFirst()
while let arg = args.popFirst() {
    switch arg {
    case "--kernel":
        kernelPath = args.popFirst()
    case "--initrd":
        initrdPath = args.popFirst()
    case "--console":
        consolePath = args.popFirst()
    case "--memory-mb":
        guard let v = args.popFirst(), let n = UInt64(v) else { fail("--memory-mb needs a number") }
        memoryMB = n
    case "--cmdline":
        guard let v = args.popFirst() else { fail("--cmdline needs a value") }
        commandLine = v
    default:
        fail("unknown argument: \(arg)")
    }
}
// トップレベルでは guard let が同じ名前の変数と衝突するので、別の名前で受ける
guard let kernel = kernelPath else { fail("usage: microgit-vm --kernel <Image> [--initrd <file>] [--console <file>] [--memory-mb N] [--cmdline S]") }
guard FileManager.default.fileExists(atPath: kernel) else { fail("kernel not found: \(kernel)") }
if let initrd = initrdPath, !FileManager.default.fileExists(atPath: initrd) { fail("initrd not found: \(initrd)") }

let consoleHandle: FileHandle
if let logPath = consolePath {
    FileManager.default.createFile(atPath: logPath, contents: nil)
    guard let h = FileHandle(forWritingAtPath: logPath) else { fail("cannot open console log: \(logPath)") }
    consoleHandle = h
} else {
    consoleHandle = FileHandle.standardError
}

let config = VZVirtualMachineConfiguration()
config.cpuCount = max(1, VZVirtualMachineConfiguration.minimumAllowedCPUCount)
config.memorySize = max(memoryMB * 1024 * 1024, VZVirtualMachineConfiguration.minimumAllowedMemorySize)

// initramfs はカーネルに埋め込んであるので、カーネルだけ渡す（arm64 は圧縮していない Image が要る）
let bootLoader = VZLinuxBootLoader(kernelURL: URL(fileURLWithPath: kernel))
bootLoader.commandLine = commandLine
if let initrd = initrdPath {
    bootLoader.initialRamdiskURL = URL(fileURLWithPath: initrd)
}
config.bootLoader = bootLoader

// hvc0: カーネルと agent のログ
let console = VZVirtioConsoleDeviceSerialPortConfiguration()
console.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: nil, fileHandleForWriting: consoleHandle)
config.serialPorts = [console]

// 名前付きポート "microgit": agent との命令の通り道。ゲストは /sys/class/virtio-ports/*/name で探す
let protocolPort = VZVirtioConsolePortConfiguration()
protocolPort.name = "microgit"
protocolPort.isConsole = false
protocolPort.attachment = VZFileHandleSerialPortAttachment(
    fileHandleForReading: FileHandle.standardInput,
    fileHandleForWriting: FileHandle.standardOutput
)
let protocolDevice = VZVirtioConsoleDeviceConfiguration()
protocolDevice.ports[0] = protocolPort
config.consoleDevices = [protocolDevice]

// ネットワーク・ディスク・共有フォルダは付けない（NFR-4。共有方式は O-2 で決める）

do {
    try config.validate()
} catch {
    fail("invalid VM configuration: \(error)")
}

final class Delegate: NSObject, VZVirtualMachineDelegate {
    func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        exit(0)
    }

    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        fail("VM stopped with error: \(error)")
    }
}

let vm = VZVirtualMachine(configuration: config)
let delegate = Delegate()
vm.delegate = delegate
vm.start { result in
    if case .failure(let error) = result {
        fail("failed to start VM: \(error)")
    }
}
dispatchMain()
