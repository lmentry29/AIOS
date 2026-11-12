import { createHash } from "node:crypto";

/**
 * Syscalls the workload may not use inside the bubblewrap boundary. This is a deny-list,
 * not a complete allow-list: it removes the highest-risk kernel attack surface while
 * leaving ordinary build/test commands usable. The list is generated into a classic BPF
 * program installed by bubblewrap before exec, so it applies to the requested argv and
 * every descendant that inherits the filter.
 *
 * A denied syscall returns SIGSYS (seccomp KILL_PROCESS). The host maps the resulting
 * bwrap exit status to a distinct durable failure instead of a generic command exit.
 */
const DENIED_SYSCALLS: Record<string, { x64: number; arm64: number }> = {
  ptrace: { x64: 101, arm64: 117 },
  mount: { x64: 165, arm64: 40 },
  umount2: { x64: 166, arm64: 39 },
  swapon: { x64: 167, arm64: 224 },
  swapoff: { x64: 168, arm64: 225 },
  reboot: { x64: 169, arm64: 142 },
  sethostname: { x64: 170, arm64: 161 },
  setdomainname: { x64: 171, arm64: 162 },
  init_module: { x64: 175, arm64: 105 },
  delete_module: { x64: 176, arm64: 106 },
  quotactl: { x64: 179, arm64: 60 },
  kexec_load: { x64: 246, arm64: 104 },
  add_key: { x64: 248, arm64: 217 },
  request_key: { x64: 249, arm64: 218 },
  keyctl: { x64: 250, arm64: 219 },
  unshare: { x64: 272, arm64: 97 },
  perf_event_open: { x64: 298, arm64: 241 },
  open_by_handle_at: { x64: 304, arm64: 265 },
  setns: { x64: 308, arm64: 268 },
  process_vm_readv: { x64: 310, arm64: 270 },
  process_vm_writev: { x64: 311, arm64: 271 },
  kcmp: { x64: 312, arm64: 272 },
  finit_module: { x64: 313, arm64: 273 },
  kexec_file_load: { x64: 320, arm64: 294 },
  bpf: { x64: 321, arm64: 280 },
  userfaultfd: { x64: 323, arm64: 282 },
  io_uring_setup: { x64: 425, arm64: 425 },
  io_uring_enter: { x64: 426, arm64: 426 },
  io_uring_register: { x64: 427, arm64: 427 },
  open_tree: { x64: 428, arm64: 428 },
  move_mount: { x64: 429, arm64: 429 },
  fsopen: { x64: 430, arm64: 430 },
  fsconfig: { x64: 431, arm64: 431 },
  fsmount: { x64: 432, arm64: 432 },
  fspick: { x64: 433, arm64: 433 },
  pidfd_getfd: { x64: 438, arm64: 438 },
  process_madvise: { x64: 440, arm64: 440 },
  mount_setattr: { x64: 442, arm64: 442 },
};

const ARCHITECTURES: Record<string, { audit: number; key: "x64" | "arm64" }> = {
  x64: { audit: 0xc000003e, key: "x64" },
  arm64: { audit: 0xc00000b7, key: "arm64" },
};

const BPF_LD_W_ABS = 0x20;
const BPF_JEQ = 0x15;
const BPF_RET = 0x06;
const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_DATA_ARCH_OFFSET = 4;
const SECCOMP_DATA_NR_OFFSET = 0;

/** bwrap exits with the child's wait status; SIGSYS is 31 on Linux. */
export const SECCOMP_DENIED_EXIT_CODE = 128 + 31;

export interface SeccompProfile {
  profile: string;
  sha256: string;
  denied_syscalls: string[];
  filter: Buffer;
}

export interface DockerSeccompProfile {
  profile: string;
  sha256: string;
}

/**
 * Docker's libseccomp profile for the same deny-list used by bubblewrap.
 *
 * Docker reads this JSON on the client side and sends the parsed policy to the daemon;
 * the workload cannot alter it. `SCMP_ACT_KILL` produces SIGSYS, matching the bubblewrap
 * filter's kill-on-denied-syscall behavior. The architecture guard is explicit so a
 * foreign ABI cannot bypass the syscall names.
 */
export function buildDockerSeccompProfile(arch: string = process.arch): DockerSeccompProfile {
  const architecture = ARCHITECTURES[arch];
  if (architecture === undefined) {
    throw new Error(`No Docker seccomp profile is defined for architecture ${arch}.`);
  }
  const profile = JSON.stringify({
    defaultAction: "SCMP_ACT_ALLOW",
    architectures: [architecture.key === "x64" ? "SCMP_ARCH_X86_64" : "SCMP_ARCH_AARCH64"],
    syscalls: [
      {
        names: Object.keys(DENIED_SYSCALLS),
        action: "SCMP_ACT_KILL",
      },
    ],
  });
  return {
    profile,
    sha256: createHash("sha256").update(profile).digest("hex"),
  };
}

function instruction(code: number, jt: number, jf: number, k: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeUInt16LE(code, 0);
  bytes.writeUInt8(jt, 2);
  bytes.writeUInt8(jf, 3);
  bytes.writeUInt32LE(k >>> 0, 4);
  return bytes;
}

/**
 * Builds a classic BPF seccomp program with an architecture guard.
 *
 * Layout: load arch, kill on mismatch; load syscall number; for each denied number,
 * jump over a KILL_PROCESS return when it does not match; finally allow. The explicit
 * architecture check prevents a 32-bit or foreign ABI from bypassing the number list.
 */
export function buildSeccompProfile(arch: string = process.arch): SeccompProfile {
  const architecture = ARCHITECTURES[arch];
  if (architecture === undefined) {
    throw new Error(`No seccomp profile is defined for architecture ${arch}.`);
  }
  const entries = Object.entries(DENIED_SYSCALLS)
    .map(([name, numbers]) => ({ name, number: numbers[architecture.key] }))
    .sort((left, right) => left.number - right.number);
  const count = entries.length;
  const allowIndex = 3 + count * 2;
  const killIndex = allowIndex + 1;
  const program: Buffer[] = [
    instruction(BPF_LD_W_ABS, 0, 0, SECCOMP_DATA_ARCH_OFFSET),
    // On a mismatched ABI, jump to the final KILL_PROCESS instruction.
    instruction(BPF_JEQ, 0, killIndex - 2, architecture.audit),
    instruction(BPF_LD_W_ABS, 0, 0, SECCOMP_DATA_NR_OFFSET),
  ];
  for (const entry of entries) {
    program.push(
      instruction(BPF_JEQ, 0, 1, entry.number),
      instruction(BPF_RET, 0, 0, SECCOMP_RET_KILL_PROCESS),
    );
  }
  program.push(
    instruction(BPF_RET, 0, 0, SECCOMP_RET_ALLOW),
    instruction(BPF_RET, 0, 0, SECCOMP_RET_KILL_PROCESS),
  );
  const filter = Buffer.concat(program);
  return {
    profile: `aios-seccomp-deny-v1-${architecture.key}`,
    sha256: createHash("sha256").update(filter).digest("hex"),
    denied_syscalls: entries.map((entry) => entry.name),
    filter,
  };
}
