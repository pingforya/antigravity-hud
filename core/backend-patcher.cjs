'use strict';

/**
 * Pure Node.js Go pclntab locator and 1M context / rules budget binary patcher for Antigravity.
 *
 * Ported from reference/fix_antigravity_context.py with byte-for-byte parity:
 * - Supports Windows x86_64 / ARM64 PE (language_server.exe, agy.exe)
 * - Supports Linux x86_64 / ARM64 ELF (language_server_linux_x64, agy)
 * - Supports macOS ARM64 Mach-O (agy / language_server_macos_arm)
 *
 * Patches (located dynamically via Go 1.20+ pclntab & getter instruction decoding):
 * 1. applyFeatureProviderCheckpointOverrideConfig -> jumps to a trampoline at +0x20 of an unreferenced
 *    (*CheckpointConfig) setter (SetSessionSummaryPromptOverride first)
 * 2. That setter -> no-op return at entry (+0x0); hosts the universal 1M context trampoline at +0x20
 *    Lifts default 256000 max_token_limit to contextLimit (512000 by default) while keeping
 *    hooks.checkpointNeeded and ClampCheckpointConfigForModelInfo intact
 * 3. readGlobalRules / parseRuleFile / convertSkillPath -> per-file byte limit 24000 -> 1048576 (1 MiB)
 * 4. computeTruncatedCustomizations -> rules & customizations token budgets 20000 -> 131072 tokens
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const TARGET_FUNCS = {
  GetPlannerConfig: 'google3/third_party/jetski/cortex_pb/cortex_go_proto.(*CascadeConfig).GetPlannerConfig',
  GetPlanModel: 'google3/third_party/jetski/cortex_pb/cortex_go_proto.(*CascadePlannerConfig).GetPlanModel',
  GetMaxTokenLimit: 'google3/third_party/jetski/cortex_pb/cortex_go_proto.(*CheckpointConfig).GetMaxTokenLimit',
  applyOverride: 'google3/third_party/jetski/cortex/config/config.applyFeatureProviderCheckpointOverrideConfig',
  checkpointNeeded: 'google3/third_party/oneharness/internal/core/hooks/hooks.checkpointNeeded',
  readGlobalRules: 'google3/third_party/jetski/cortex/customizations/customizations.(*Manager).readGlobalRules',
  parseRuleFile: 'google3/third_party/jetski/cortex/customizations/customizations.(*Manager).parseRuleFile',
  convertSkillPath: 'google3/third_party/jetski/cortex/customizations/customizations.convertSkillPath',
  computeTruncated: 'google3/third_party/jetski/cortex/customizations/customizations.(*Manager).computeTruncatedCustomizations'
};

const HOST_SYMBOL_MARKER = 'cortex_pb/cortex_go_proto.(*CheckpointConfig).';
const HOST_FALLBACK_SYMBOLS = [
  'google3/third_party/jetski/language_server/jetbox_state_store/jetbox_state_store.forwardChanges',
  'google3/third_party/jetski/language_server/auth_client/authclient.closeListeners',
  'google3/third_party/jetski/cortex/implicit/implicit.recordCortexTrajectory',
  'google3/third_party/jetski/language_server/streaming/streaming.(*CompletionStreamer).Close'
];
const HOST_PREFERENCE = [
  '(*CheckpointConfig).SetSessionSummaryPromptOverride',
  '(*CheckpointConfig).SetContextWindow',
  '(*CheckpointConfig).SetCheckpointPromptOverride',
  '(*CheckpointConfig).SetContinuationPromptOverride',
  ...HOST_FALLBACK_SYMBOLS
];
const HOST_SPAN = { x86_64: 0x20 + 46, arm64: 0x20 + 48 };
const HOST_NOOP_ENTRY = {
  x86_64: Buffer.from('31c031db31c9c3', 'hex'),
  arm64: (() => {
    const b = Buffer.alloc(16);
    b.writeUInt32LE(0xD2800000, 0);
    b.writeUInt32LE(0xD2800001, 4);
    b.writeUInt32LE(0xD2800002, 8);
    b.writeUInt32LE(0xD65F03C0, 12);
    return b;
  })()
};
const DATA_SEGMENT_SKIP = [
  '__DWARF', '__LINKEDIT', '__eh_frame', '.debug', '.zdebug',
  '.reloc', '.rela', '.rsrc', '.symtab', '.strtab', '.comment', '.note', '.pdata'
];

const DEFAULT_256K_TOKEN_LIMIT = 256000;
const DEFAULT_CONTEXT_LIMIT = 512000;
const HIGH_CONTEXT_LIMIT = 734000;
const MAX_CONTEXT_LIMIT = 1048576;
const ACCEPTED_LIMITS = [512000, 734000, 900000, 983040];
const DEFAULT_BACKUP_DIR = path.join(os.homedir(), '.gemini', 'agy-patches');

function toHex(n) {
  return '0x' + Number(n).toString(16);
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function findInRange(buf, needle, start, end) {
  const s = Math.max(0, start);
  const e = Math.min(buf.length, end);
  if (s >= e || e - s < needle.length) return -1;
  return buf.subarray(0, e).indexOf(needle, s);
}

function rfindInRange(buf, needle, start, end) {
  const s = Math.max(0, start);
  const e = Math.min(buf.length, end);
  if (s >= e || e - s < needle.length) return -1;
  const rel = buf.subarray(s, e).lastIndexOf(needle);
  return rel === -1 ? -1 : s + rel;
}

function packU32(val) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(val >>> 0, 0);
  return b;
}

function packI32(val) {
  const b = Buffer.alloc(4);
  b.writeInt32LE(val | 0, 0);
  return b;
}

function packU32Array(words) {
  const b = Buffer.alloc(words.length * 4);
  for (let i = 0; i < words.length; i++) {
    b.writeUInt32LE(words[i] >>> 0, i * 4);
  }
  return b;
}

function resolveCanonical(p) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
  } catch {
    try {
      return path.resolve(p);
    } catch {
      return null;
    }
  }
}

function normcasePath(p) {
  const s = String(p);
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

class BinaryImage {
  constructor(data) {
    this.data = Buffer.isBuffer(data) ? data : Buffer.from(data);
    this.fmt = null;
    this.arch = null;
    this.segments = []; // { name, va, vsize, rawPtr, rawSize, isExec }
    this._parse();
  }

  _parse() {
    const d = this.data;
    if (d.length >= 2 && d[0] === 0x4D && d[1] === 0x5A) {
      this.fmt = 'PE';
      if (d.length < 0x40) throw new Error('Truncated PE DOS header');
      const eLfanew = d.readUInt32LE(0x3C);
      if (eLfanew + 24 > d.length) {
        throw new Error('Invalid PE header offset');
      }
      if (d.subarray(eLfanew, eLfanew + 4).toString('latin1') !== 'PE\x00\x00') {
        throw new Error('Invalid PE signature');
      }
      const machine = d.readUInt16LE(eLfanew + 4);
      const numSections = d.readUInt16LE(eLfanew + 6);
      const optHdrSize = d.readUInt16LE(eLfanew + 20);
      if (machine === 0x8664) {
        this.arch = 'x86_64';
      } else if (machine === 0xAA64) {
        this.arch = 'arm64';
      } else {
        throw new Error(`Unsupported PE machine: ${toHex(machine)}`);
      }
      const optOff = eLfanew + 24;
      if (optHdrSize < 32 || optOff + optHdrSize > d.length) {
        throw new Error('Truncated PE32+ optional header');
      }
      const magic = d.readUInt16LE(optOff);
      if (magic !== 0x20B) {
        throw new Error(`Expected PE32+ (0x20b), got ${toHex(magic)}`);
      }
      const imageBase = Number(d.readBigUInt64LE(optOff + 24));
      if (!Number.isSafeInteger(imageBase)) {
        throw new Error('PE imageBase exceeds safe integer range');
      }
      const secOff = optOff + optHdrSize;
      if (secOff + numSections * 40 > d.length) {
        throw new Error('Truncated PE section table');
      }
      for (let i = 0; i < numSections; i++) {
        const s = secOff + i * 40;
        let nameEnd = s + 8;
        while (nameEnd > s && d[nameEnd - 1] === 0) nameEnd--;
        const name = d.subarray(s, nameEnd).toString('ascii');
        const vsize = d.readUInt32LE(s + 8);
        const rva = d.readUInt32LE(s + 12);
        const rawSize = d.readUInt32LE(s + 16);
        const rawPtr = d.readUInt32LE(s + 20);
        const chars = d.readUInt32LE(s + 36);
        if (rawSize > 0 && (rawPtr > d.length || rawSize > d.length - rawPtr)) {
          throw new Error(`PE section ${name || i} exceeds file size`);
        }
        const segVa = imageBase + rva;
        const segVsize = Math.max(vsize, rawSize);
        if (!Number.isSafeInteger(segVa) || !Number.isSafeInteger(segVa + segVsize)) {
          throw new Error(`PE section ${name || i} virtual address exceeds safe integer range`);
        }
        const isExec = Boolean(chars & 0x20000000) || name === '.text';
        this.segments.push({
          name,
          va: segVa,
          vsize: segVsize,
          rawPtr,
          rawSize,
          isExec
        });
      }
    } else if (d.length >= 4 && d[0] === 0x7F && d[1] === 0x45 && d[2] === 0x4C && d[3] === 0x46) {
      this.fmt = 'ELF';
      if (d.length < 64) throw new Error('Truncated ELF64 header');
      if (d[4] !== 2 || d[5] !== 1) throw new Error('Only 64-bit little-endian ELF is supported');
      const eMachine = d.readUInt16LE(18);
      if (eMachine === 0x3E) {
        this.arch = 'x86_64';
      } else if (eMachine === 0xB7) {
        this.arch = 'arm64';
      } else {
        throw new Error(`Unsupported ELF machine: ${toHex(eMachine)}`);
      }
      const ePhoff = Number(d.readBigUInt64LE(32));
      const ePhentsize = d.readUInt16LE(54);
      const ePhnum = d.readUInt16LE(56);
      if (
        !Number.isSafeInteger(ePhoff) ||
        ePhentsize < 56 ||
        ePhoff > d.length ||
        ePhentsize * ePhnum > d.length - ePhoff
      ) {
        throw new Error('Invalid ELF64 program header table');
      }
      for (let i = 0; i < ePhnum; i++) {
        const ph = ePhoff + i * ePhentsize;
        const pType = d.readUInt32LE(ph);
        const pFlags = d.readUInt32LE(ph + 4);
        const pOffset = Number(d.readBigUInt64LE(ph + 8));
        const pVaddr = Number(d.readBigUInt64LE(ph + 16));
        const pFilesz = Number(d.readBigUInt64LE(ph + 32));
        const pMemsz = Number(d.readBigUInt64LE(ph + 40));
        if (pType === 1) {
          const segVsize = Math.max(pMemsz, pFilesz);
          if (
            !Number.isSafeInteger(pOffset) ||
            !Number.isSafeInteger(pVaddr) ||
            !Number.isSafeInteger(pFilesz) ||
            !Number.isSafeInteger(pMemsz) ||
            !Number.isSafeInteger(pVaddr + segVsize) ||
            pFilesz > pMemsz ||
            pOffset > d.length ||
            pFilesz > d.length - pOffset
          ) {
            throw new Error('Invalid ELF64 load segment');
          }
          this.segments.push({
            name: `LOAD_${i}`,
            va: pVaddr,
            vsize: segVsize,
            rawPtr: pOffset,
            rawSize: pFilesz,
            isExec: Boolean(pFlags & 1)
          });
        }
      }
    } else if (d.length >= 4 && d.readUInt32LE(0) === 0xFEEDFACF) {
      this.fmt = 'Mach-O';
      if (d.length < 32) throw new Error('Truncated Mach-O header');
      const cpu = d.readUInt32LE(4);
      const ncmds = d.readUInt32LE(16);
      const sizeofcmds = d.readUInt32LE(20);
      if (cpu !== 0x0100000C) {
        throw new Error('Only thin ARM64 Mach-O is supported on macOS');
      }
      this.arch = 'arm64';
      const end = 32 + sizeofcmds;
      if (end > d.length || ncmds > Math.floor(sizeofcmds / 8)) {
        throw new Error('Invalid Mach-O load command table');
      }
      let off = 32;
      for (let i = 0; i < ncmds; i++) {
        if (off + 8 > end) throw new Error('Truncated Mach-O load command');
        const cmd = d.readUInt32LE(off);
        const size = d.readUInt32LE(off + 4);
        if (size < 8 || off + size > end) throw new Error('Invalid Mach-O load command size');
        if (cmd === 0x19) {
          if (size < 72) throw new Error('Truncated Mach-O segment');
          let nameEnd = off + 24;
          while (nameEnd > off + 8 && d[nameEnd - 1] === 0) nameEnd--;
          const name = d.subarray(off + 8, nameEnd).toString('ascii');
          const va = Number(d.readBigUInt64LE(off + 24));
          const vsize = Number(d.readBigUInt64LE(off + 32));
          const rawPtr = Number(d.readBigUInt64LE(off + 40));
          const rawSize = Number(d.readBigUInt64LE(off + 48));
          const prot = d.readInt32LE(off + 60);
          if (
            !Number.isSafeInteger(rawPtr) ||
            !Number.isSafeInteger(rawSize) ||
            rawPtr > d.length ||
            rawSize > d.length - rawPtr
          ) {
            throw new Error('Mach-O segment exceeds file size');
          }
          if (
            !Number.isSafeInteger(va) ||
            !Number.isSafeInteger(vsize) ||
            !Number.isSafeInteger(va + vsize)
          ) {
            throw new Error(`Mach-O segment ${name || i} virtual address exceeds safe integer range`);
          }
          this.segments.push({
            name,
            va,
            vsize,
            rawPtr,
            rawSize,
            isExec: Boolean(prot & 4)
          });
        }
        off += size;
      }
    } else {
      throw new Error('Unsupported binary format (expected PE, ELF or thin ARM64 Mach-O)');
    }
  }

  vaToFile(va) {
    for (const seg of this.segments) {
      if (seg.va <= va && va < seg.va + seg.rawSize) {
        return seg.rawPtr + (va - seg.va);
      }
    }
    throw new Error(`Virtual address ${toHex(va)} is not mapped to file bytes`);
  }
}

function bsearchFtab(data, ftabBase, nfunc, targetFuncOff) {
  let lo = 0;
  let hi = nfunc - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const foff = data.readUInt32LE(ftabBase + mid * 8 + 4);
    if (foff === targetFuncOff) return mid;
    if (foff < targetFuncOff) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

function describeFunction(img, goTextVa, symbol, pcStart, pcEnd) {
  const vaStart = goTextVa + pcStart;
  const fileStart = img.vaToFile(vaStart);
  return {
    symbol,
    pc_start: pcStart,
    pc_end: pcEnd,
    va_start: vaStart,
    va_end: goTextVa + pcEnd,
    file_start: fileStart,
    file_end: fileStart + (pcEnd - pcStart)
  };
}

function locateGoFunctions(img) {
  const magic = img.arch === 'x86_64'
    ? Buffer.from([0xF1, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x01, 0x08])
    : Buffer.from([0xF1, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x04, 0x08]);
  const wantRev = new Map(Object.entries(TARGET_FUNCS).map(([k, v]) => [v, k]));
  const data = img.data;
  let pos = 0;
  while (true) {
    const idx = data.indexOf(magic, pos);
    if (idx === -1) break;
    pos = idx + 1;
    if (idx + 72 > data.length) continue;

    const nfunc = Number(data.readBigUInt64LE(idx + 8));
    const textStart = Number(data.readBigUInt64LE(idx + 24));
    const funcnameOff = Number(data.readBigUInt64LE(idx + 32));
    const cuOff = Number(data.readBigUInt64LE(idx + 40));
    const pclnOff = Number(data.readBigUInt64LE(idx + 64));

    if (!(nfunc > 1000 && nfunc < 5000000 && funcnameOff < data.length && pclnOff < data.length)) {
      continue;
    }
    const ftabBase = idx + pclnOff;
    const namesBase = idx + funcnameOff;
    if (ftabBase < idx || ftabBase + (nfunc + 1) * 8 > data.length) continue;
    const namesEnd = cuOff > funcnameOff ? Math.min(data.length, idx + cuOff) : data.length;
    if (namesBase < idx || namesBase >= data.length || namesBase > namesEnd) continue;
    const firstFoff = data.readUInt32LE(ftabBase + 4);
    const lastFoff = data.readUInt32LE(ftabBase + (nfunc - 1) * 8 + 4);
    if (firstFoff > data.length - ftabBase || lastFoff < firstFoff || lastFoff > data.length - ftabBase) {
      continue;
    }
    const funcrecStart = ftabBase + firstFoff;
    const funcrecEnd = Math.min(data.length, ftabBase + lastFoff + 64);

    const lookupNameOff = (noff, hint = funcrecStart) => {
      const needle = packI32(noff);
      const starts = hint > funcrecStart ? [hint, funcrecStart] : [funcrecStart];
      for (const startPos of starts) {
        let cur = startPos;
        while (true) {
          const at = findInRange(data, needle, cur, funcrecEnd);
          if (at === -1) break;
          const i = bsearchFtab(data, ftabBase, nfunc, (at - 4) - ftabBase);
          if (i !== -1) {
            const sOff = data.readUInt32LE(ftabBase + i * 8);
            const eOff = data.readUInt32LE(ftabBase + (i + 1) * 8);
            return [[sOff, eOff], at + 4];
          }
          cur = at + 1;
        }
      }
      return [null, hint];
    };

    const found = {};
    for (const [k, sym] of Object.entries(TARGET_FUNCS)) {
      const symBuf = Buffer.from(sym, 'utf8');
      const wrapped = Buffer.concat([Buffer.from([0]), symBuf, Buffer.from([0])]);
      let at = findInRange(data, wrapped, namesBase - 1, namesEnd);
      if (at === -1) {
        const prefix = Buffer.concat([symBuf, Buffer.from([0])]);
        if (data.subarray(namesBase, namesBase + prefix.length).equals(prefix)) {
          at = namesBase - 1;
        }
      }
      if (at !== -1) {
        const [bounds] = lookupNameOff((at + 1) - namesBase);
        if (bounds) found[k] = bounds;
      }
    }

    const hosts = {};
    if (Object.keys(found).length === Object.keys(TARGET_FUNCS).length) {
      const marker = Buffer.from(HOST_SYMBOL_MARKER, 'utf8');
      const nul = Buffer.from([0]);
      let mPos = namesBase;
      let recHint = funcrecStart;
      while (true) {
        const at = findInRange(data, marker, mPos, namesEnd);
        if (at === -1) break;
        let sStart = rfindInRange(data, nul, namesBase - 1, at);
        sStart = sStart === -1 ? namesBase : sStart + 1;
        const sEnd = findInRange(data, nul, at, namesEnd);
        if (sEnd === -1) break;
        const name = data.subarray(sStart, sEnd).toString('utf8');
        if (!wantRev.has(name)) {
          const [bounds, nextHint] = lookupNameOff(sStart - namesBase, recHint);
          recHint = nextHint;
          if (bounds) hosts[name] = bounds;
        }
        mPos = sEnd + 1;
      }
      for (const fbSym of HOST_FALLBACK_SYMBOLS) {
        const fbBuf = Buffer.from(fbSym, 'utf8');
        const wrapped = Buffer.concat([Buffer.from([0]), fbBuf, Buffer.from([0])]);
        let at = findInRange(data, wrapped, namesBase - 1, namesEnd);
        if (at === -1) {
          const prefix = Buffer.concat([fbBuf, Buffer.from([0])]);
          if (data.subarray(namesBase, namesBase + prefix.length).equals(prefix)) {
            at = namesBase - 1;
          }
        }
        if (at !== -1) {
          const [bounds] = lookupNameOff((at + 1) - namesBase);
          if (bounds) hosts[fbSym] = bounds;
        }
      }

      let goTextVa = textStart;
      if (goTextVa === 0) {
        const totalLenBig = BigInt(data.readUInt32LE(ftabBase + nfunc * 8));
        const execRanges = img.segments
          .filter((s) => s.isExec)
          .map((s) => [BigInt(s.va), BigInt(s.va + s.vsize)]);
        const inExecRange = (minpc) => execRanges.some(([lo, hi]) => minpc >= lo && minpc < hi);

        let pclnVa = null;
        for (const seg of img.segments) {
          if (seg.rawPtr <= idx && idx < seg.rawPtr + seg.rawSize) {
            pclnVa = seg.va + (idx - seg.rawPtr);
            break;
          }
        }
        if (pclnVa !== null) {
          const needle = Buffer.alloc(8);
          needle.writeBigUInt64LE(BigInt(pclnVa), 0);
          for (const seg of img.segments) {
            if (seg.isExec || seg.rawSize < 256) continue;
            let sPos = seg.rawPtr;
            const limit = seg.rawPtr + seg.rawSize - 240;
            while (true) {
              const at = findInRange(data, needle, sPos, limit);
              if (at === -1) break;
              for (let mOff = at + 8; mOff < at + 240; mOff += 8) {
                const minpc = data.readBigUInt64LE(mOff);
                const maxpc = data.readBigUInt64LE(mOff + 8);
                if (maxpc - minpc === totalLenBig && inExecRange(minpc)) {
                  goTextVa = Number(minpc);
                  break;
                }
              }
              if (goTextVa !== 0) break;
              sPos = at + 1;
            }
            if (goTextVa !== 0) break;
          }
        }
        if (goTextVa === 0) {
          for (const seg of img.segments) {
            if (seg.isExec) continue;
            for (let off = seg.rawPtr; off < seg.rawPtr + seg.rawSize - 16; off += 8) {
              const minpc = data.readBigUInt64LE(off);
              const maxpc = data.readBigUInt64LE(off + 8);
              if (maxpc - minpc === totalLenBig && inExecRange(minpc)) {
                goTextVa = Number(minpc);
                break;
              }
            }
            if (goTextVa !== 0) break;
          }
        }
      }
      if (goTextVa === 0) {
        throw new Error('Found pclntab but could not resolve Go text base VA from moduledata');
      }
      const funcs = {};
      for (const [k, [sOff, eOff]] of Object.entries(found)) {
        funcs[k] = describeFunction(img, goTextVa, TARGET_FUNCS[k], sOff, eOff);
      }
      return { pclnOff: idx, goTextVa, funcs, hosts };
    }
  }
  throw new Error(`Could not locate the ${Object.keys(TARGET_FUNCS).length} required Go functions in pclntab`);
}

function orderHostCandidates(hosts) {
  const ordered = [];
  const seen = new Set();
  const hostNames = Object.keys(hosts);
  for (const suffix of HOST_PREFERENCE) {
    const matches = hostNames.filter((n) => n.endsWith(suffix) && !seen.has(n)).sort();
    for (const m of matches) {
      ordered.push(m);
      seen.add(m);
    }
  }
  const rest = hostNames
    .filter((n) => !seen.has(n))
    .sort((a, b) => {
      const lenA = hosts[a][1] - hosts[a][0];
      const lenB = hosts[b][1] - hosts[b][0];
      if (lenA !== lenB) return lenA - lenB;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  ordered.push(...rest);
  return ordered;
}

function goTextBounds(img, goTextVa) {
  for (const seg of img.segments) {
    if (seg.isExec && seg.va <= goTextVa && goTextVa < seg.va + seg.vsize) {
      return { lo: seg.rawPtr, hi: seg.rawPtr + seg.rawSize, delta: seg.va - seg.rawPtr };
    }
  }
  throw new Error('Go text is not inside an executable segment');
}

function maybeSignExtend(value, bits) {
  const sign = 1 << (bits - 1);
  return (value & sign) ? value - (sign << 1) : value;
}

function collectTextReferences(img, goTextVa, wantedIterable) {
  const wanted = new Set(wantedIterable);
  if (wanted.size === 0) return new Map();
  const { lo, hi, delta } = goTextBounds(img, goTextVa);
  const data = img.data;
  const sites = new Map();

  const note = (target, site) => {
    if (wanted.has(target)) {
      let list = sites.get(target);
      if (!list) {
        list = [];
        sites.set(target, list);
      }
      list.push(site);
    }
  };

  if (img.arch === 'x86_64') {
    const specs = [
      { opcode: 0xE8, length: 5, rel32: true },
      { opcode: 0xE9, length: 5, rel32: true },
      { opcode: 0xEB, length: 2, rel32: false }
    ];
    for (const { opcode, length, rel32 } of specs) {
      const limit = hi - length;
      const view = data.subarray(0, limit);
      let pos = lo;
      while (pos < limit) {
        pos = view.indexOf(opcode, pos);
        if (pos === -1) break;
        const disp = rel32 ? data.readInt32LE(pos + 1) : data.readInt8(pos + 1);
        note(pos + delta + length + disp, pos + delta);
        pos += 1;
      }
    }
    return sites;
  }

  const span = Math.floor((hi - lo) / 4) * 4;
  for (let offset = lo; offset < lo + span; offset += 4) {
    const top = data[offset + 3];
    if (
      !((top >= 0x14 && top <= 0x17) ||
        (top >= 0x34 && top <= 0x37) ||
        top === 0x54 ||
        (top >= 0x94 && top <= 0x97) ||
        (top >= 0xB4 && top <= 0xB7))
    ) {
      continue;
    }
    const word = data.readUInt32LE(offset);
    const site = offset + delta;
    if ((word & 0x7C000000) === 0x14000000) {
      note(site + maybeSignExtend(word & 0x03FFFFFF, 26) * 4, site);
    } else if ((word & 0xFF000010) === 0x54000000) {
      note(site + maybeSignExtend((word >>> 5) & 0x7FFFF, 19) * 4, site);
    } else if ((word & 0x7E000000) === 0x34000000) {
      note(site + maybeSignExtend((word >>> 5) & 0x7FFFF, 19) * 4, site);
    } else if ((word & 0x7E000000) === 0x36000000) {
      note(site + maybeSignExtend((word >>> 5) & 0x3FFF, 14) * 4, site);
    }
  }
  return sites;
}

function storedAddressPresent(img, funcVa, goTextVa = null) {
  const needle64 = Buffer.alloc(8);
  needle64.writeBigUInt64LE(BigInt(funcVa), 0);
  const relOff = goTextVa !== null ? funcVa - goTextVa : -1;
  const needle32 = (goTextVa !== null && relOff > 0 && relOff <= 0xFFFFFFFF)
    ? packU32(relOff)
    : null;

  for (const seg of img.segments) {
    if (!seg.rawSize || DATA_SEGMENT_SKIP.some((p) => seg.name.startsWith(p))) {
      continue;
    }
    if (findInRange(img.data, needle64, seg.rawPtr, seg.rawPtr + seg.rawSize) !== -1) {
      return true;
    }
    if (needle32 !== null && !seg.isExec && !['.rdata', '.rodata', '.gopclntab'].includes(seg.name)) {
      let pos = seg.rawPtr;
      const end = seg.rawPtr + seg.rawSize;
      while (true) {
        const at = findInRange(img.data, needle32, pos, end);
        if (at === -1) break;
        if ((at - seg.rawPtr) % 4 === 0) return true;
        pos = at + 1;
      }
    }
  }
  return false;
}

function externallyReferenced(func, sites) {
  if (!sites || sites.length === 0) return false;
  return sites.some((site) => !(func.va_start <= site && site < func.va_end));
}

function entryHasNopFill(arch, span) {
  if (arch === 'arm64') {
    const limit = Math.floor(span.length / 4) * 4;
    for (let i = 0; i < limit; i += 4) {
      if (span.readUInt32LE(i) === 0xD503201F) return true;
    }
    return false;
  }
  let count = 0;
  for (let i = 0; i < span.length; i++) {
    if (span[i] === 0x90) {
      count++;
      if (count >= 2) return true;
    }
  }
  return false;
}

function subsZeroForm(word) {
  if (((word & 0xFFE0001F) >>> 0) === 0xEB00001F && ((word >>> 10) & 0x3F) === 0) {
    return 'shifted';
  }
  if (((word & 0xFFE0001F) >>> 0) === 0xEB20001F && ((word >>> 10) & 0x3F) === 0x18) {
    return 'extended';
  }
  return null;
}

function validCheckpointEntry(img, func) {
  const code = img.data.subarray(func.file_start, func.file_end);
  if (img.arch === 'arm64') {
    if (code.length < 12) return false;
    const count = Math.min(4, Math.floor(code.length / 4));
    const words = [];
    for (let i = 0; i < count; i++) words.push(code.readUInt32LE(i * 4));
    if (words[0] !== 0xF9400B90) return false;
    let branchAt;
    let compare;
    if (words.length >= 4 && ((words[1] & 0xFFC003FF) >>> 0) === 0xD10003F1) {
      branchAt = 3;
      compare = words[2];
    } else if (subsZeroForm(words[1]) !== null) {
      branchAt = 2;
      compare = words[1];
    } else {
      return false;
    }
    const form = subsZeroForm(compare);
    if (!form) return false;
    const opA = (compare >>> 5) & 0x1F;
    const opB = (compare >>> 16) & 0x1F;
    const loOp = Math.min(opA, opB);
    const hiOp = Math.max(opA, opB);
    const validOps = form === 'extended'
      ? (loOp === 16 && (hiOp === 17 || hiOp === 31))
      : (loOp === 16 && hiOp === 17);
    if (!validOps || words.length <= branchAt) return false;
    const branch = words[branchAt];
    if (((branch & 0xFF00001F) >>> 0) !== 0x54000009) return false;
    const displacement = maybeSignExtend((branch >>> 5) & 0x7FFFF, 19);
    const destination = branchAt * 4 + displacement * 4;
    return branchAt * 4 < destination && destination <= code.length - 4;
  }

  let branchAt = -1;
  if (code.length >= 4 && code.subarray(0, 4).equals(Buffer.from('493b6610', 'hex'))) {
    branchAt = 4;
  } else if (
    code.length >= 12 &&
    code.subarray(0, 4).equals(Buffer.from('4c8da424', 'hex')) &&
    code.subarray(8, 12).equals(Buffer.from('4d3b6610', 'hex'))
  ) {
    branchAt = 12;
  } else if (
    code.length >= 9 &&
    code.subarray(0, 4).equals(Buffer.from('4c8d6424', 'hex')) &&
    code.subarray(5, 9).equals(Buffer.from('4d3b6610', 'hex'))
  ) {
    branchAt = 9;
  } else {
    return false;
  }

  if (code.length >= branchAt + 2 && code[branchAt] === 0x76) {
    const destination = branchAt + 2 + code.readInt8(branchAt + 1);
    return branchAt + 2 <= destination && destination < code.length;
  }
  if (code.length >= branchAt + 6 && code[branchAt] === 0x0F && code[branchAt + 1] === 0x86) {
    const destination = branchAt + 6 + code.readInt32LE(branchAt + 2);
    return branchAt + 6 <= destination && destination < code.length;
  }
  return false;
}

function chooseTrampolineHost(img, funcs, hosts, goTextVa) {
  if (!hosts || Object.keys(hosts).length === 0) {
    throw new Error('No (*CheckpointConfig) method is available to host the trampoline');
  }
  const required = new Set(Object.values(funcs).map((f) => f.symbol));
  const candidates = orderHostCandidates(hosts).filter((n) => !required.has(n));
  const records = {};
  for (const n of candidates) {
    records[n] = describeFunction(img, goTextVa, n, hosts[n][0], hosts[n][1]);
  }
  const noop = HOST_NOOP_ENTRY[img.arch];

  for (const name of candidates) {
    const func = records[name];
    if (
      func.file_end - func.file_start >= HOST_SPAN[img.arch] &&
      img.data.subarray(func.file_start, func.file_start + noop.length).equals(noop)
    ) {
      return { host: func, hostAmbiguous: false };
    }
  }

  const references = collectTextReferences(
    img,
    goTextVa,
    Object.values(records).map((r) => r.va_start)
  );
  const rejected = [];
  let firstUnclean = null;
  for (const name of candidates) {
    const func = records[name];
    const size = func.file_end - func.file_start;
    if (size < HOST_SPAN[img.arch]) {
      rejected.push(`${name}: ${size} bytes`);
      continue;
    }
    if (externallyReferenced(func, references.get(func.va_start))) {
      rejected.push(`${name}: branched to`);
      continue;
    }
    if (storedAddressPresent(img, func.va_start, goTextVa)) {
      rejected.push(`${name}: address stored`);
      continue;
    }
    const span = img.data.subarray(func.file_start, func.file_start + noop.length);
    if (validCheckpointEntry(img, func) && !entryHasNopFill(img.arch, span)) {
      return { host: func, hostAmbiguous: firstUnclean !== null };
    }
    if (firstUnclean === null) {
      firstUnclean = func;
    }
  }
  if (firstUnclean !== null) {
    return { host: firstUnclean, hostAmbiguous: true };
  }
  throw new Error(
    `No unreferenced (*CheckpointConfig) method can host the trampoline (${rejected.slice(0, 4).join('; ') || 'none present'})`
  );
}

function buildX86_64Plan(img, funcs, contextLimit = DEFAULT_CONTEXT_LIMIT) {
  const data = img.data;
  const fbytes = (k) => {
    const f = funcs[k];
    return data.subarray(f.file_start, f.file_end);
  };

  const bPlanner = fbytes('GetPlannerConfig');
  if (
    bPlanner.length < 10 ||
    !bPlanner.subarray(0, 7).equals(Buffer.from([0x48, 0x85, 0xC0, 0x74, 0x05, 0x48, 0x8B])) ||
    bPlanner[7] !== 0x40 ||
    bPlanner[9] !== 0xC3
  ) {
    throw new Error(`Unexpected GetPlannerConfig bytes: ${bPlanner.subarray(0, 12).toString('hex')}`);
  }
  const plannerOff = bPlanner[8];

  const bModel = fbytes('GetPlanModel');
  if (
    bModel.length < 9 ||
    !bModel.subarray(0, 6).equals(Buffer.from([0x48, 0x85, 0xC0, 0x74, 0x04, 0x8B])) ||
    bModel[6] !== 0x40 ||
    bModel[8] !== 0xC3
  ) {
    throw new Error(`Unexpected GetPlanModel bytes: ${bModel.subarray(0, 12).toString('hex')}`);
  }
  const planModelOff = bModel[7];

  const bLimit = fbytes('GetMaxTokenLimit');
  if (
    bLimit.length < 9 ||
    !bLimit.subarray(0, 6).equals(Buffer.from([0x48, 0x85, 0xC0, 0x74, 0x04, 0x8B])) ||
    bLimit[6] !== 0x40 ||
    bLimit[8] !== 0xC3
  ) {
    throw new Error(`Unexpected GetMaxTokenLimit bytes: ${bLimit.subarray(0, 12).toString('hex')}`);
  }
  const maxLimitOff = bLimit[7];

  const bApply = fbytes('applyOverride');
  const fApply = funcs.applyOverride;
  const epilogueSeq = Buffer.from([0x31, 0xC9, 0xC9, 0xC3]);
  const tailIdx = bApply.indexOf(epilogueSeq);
  if (tailIdx < 9 || bApply.indexOf(epilogueSeq, tailIdx + 1) !== -1) {
    throw new Error('Could not uniquely locate epilogue (31 c9 c9 c3) in applyFeatureProviderCheckpointOverrideConfig');
  }

  const fChk = funcs.trampolineHost;
  if (fChk.file_end - fChk.file_start < HOST_SPAN[img.arch]) {
    throw new Error(`${fChk.symbol} is too small to host the trampoline`);
  }
  const chkVa = fChk.va_start;
  const chkFoff = fChk.file_start;
  const trampVa = chkVa + 0x20;
  const trampFoff = chkFoff + 0x20;

  const exitRelA = tailIdx - 6;
  const exitCurA = bApply.subarray(exitRelA, exitRelA + 6);
  const exitRelB = tailIdx - 9;
  const exitCurB = bApply.subarray(exitRelB, exitRelB + 9);
  const trampDone = data.subarray(trampFoff + 35, trampFoff + 41);

  let exitLayout;
  let checkpointOff;
  let exitRel;
  if (
    exitCurA.subarray(0, 3).equals(Buffer.from([0x48, 0x89, 0x48])) &&
    exitCurA.subarray(4, 6).equals(Buffer.from([0x31, 0xDB]))
  ) {
    exitLayout = 'rax_rcx';
    checkpointOff = exitCurA[3];
    exitRel = exitRelA;
  } else if (
    exitCurB.subarray(0, 3).equals(Buffer.from([0x48, 0x89, 0x42])) &&
    exitCurB.subarray(4, 9).equals(Buffer.from([0x48, 0x89, 0xD0, 0x31, 0xDB]))
  ) {
    exitLayout = 'rdx_rax';
    checkpointOff = exitCurB[3];
    exitRel = exitRelB;
  } else if (
    trampDone.subarray(0, 3).equals(Buffer.from([0x48, 0x89, 0x48])) &&
    trampDone.subarray(4, 6).equals(Buffer.from([0x31, 0xDB])) &&
    exitCurA[0] === 0xE9 &&
    exitCurA[5] === 0x90
  ) {
    exitLayout = 'rax_rcx';
    checkpointOff = trampDone[3];
    exitRel = exitRelA;
  } else if (
    trampDone.subarray(0, 3).equals(Buffer.from([0x48, 0x89, 0x42])) &&
    trampDone.subarray(4, 6).equals(Buffer.from([0x31, 0xDB])) &&
    exitCurB[0] === 0xE9 &&
    exitCurB.subarray(5, 9).equals(Buffer.from([0x90, 0x48, 0x89, 0xD0]))
  ) {
    exitLayout = 'rdx_rax';
    checkpointOff = trampDone[3];
    exitRel = exitRelB;
  } else {
    throw new Error(`Unrecognized instruction sequence at applyOverride exit: ${exitCurB.toString('hex')}`);
  }

  const exitVa = fApply.va_start + exitRel;
  const exitFoff = fApply.file_start + exitRel;
  const jmpToTrampRel = trampVa - (exitVa + 5);
  if (jmpToTrampRel < -0x80000000 || jmpToTrampRel > 0x7FFFFFFF) {
    throw new Error('Trampoline is out of 32-bit relative jump range');
  }
  const jmpBackRel = (exitVa + 6) - (trampVa + 46);
  if (jmpBackRel < -0x80000000 || jmpBackRel > 0x7FFFFFFF) {
    throw new Error('Trampoline return jump is out of 32-bit relative jump range');
  }

  let exitBefore;
  let exitAfter;
  let trampAfter;
  if (exitLayout === 'rax_rcx') {
    exitBefore = Buffer.from([0x48, 0x89, 0x48, checkpointOff, 0x31, 0xDB]);
    exitAfter = Buffer.concat([Buffer.from([0xE9]), packI32(jmpToTrampRel), Buffer.from([0x90])]);
    trampAfter = Buffer.concat([
      Buffer.from([0x48, 0x85, 0xC9]),
      Buffer.from([0x74, 0x1E]),
      Buffer.from([0x48, 0x8B, 0x50, plannerOff]),
      Buffer.from([0x48, 0x85, 0xD2]),
      Buffer.from([0x74, 0x15]),
      Buffer.from([0x8B, 0x51, maxLimitOff]),
      Buffer.from([0x81, 0xFA]),
      packU32(DEFAULT_256K_TOKEN_LIMIT),
      Buffer.from([0x75, 0x0A]),
      Buffer.from([0x0F, 0x1F, 0x00]),
      Buffer.from([0xC7, 0x41, maxLimitOff]),
      packU32(contextLimit),
      Buffer.from([0x48, 0x89, 0x48, checkpointOff]),
      Buffer.from([0x31, 0xDB]),
      Buffer.from([0xE9]),
      packI32(jmpBackRel)
    ]);
  } else {
    exitBefore = Buffer.from([0x48, 0x89, 0x42, checkpointOff, 0x48, 0x89, 0xD0, 0x31, 0xDB]);
    exitAfter = Buffer.concat([
      Buffer.from([0xE9]),
      packI32(jmpToTrampRel),
      Buffer.from([0x90, 0x48, 0x89, 0xD0])
    ]);
    trampAfter = Buffer.concat([
      Buffer.from([0x48, 0x85, 0xC0]),
      Buffer.from([0x74, 0x1E]),
      Buffer.from([0x48, 0x8B, 0x4A, plannerOff]),
      Buffer.from([0x48, 0x85, 0xC9]),
      Buffer.from([0x74, 0x15]),
      Buffer.from([0x8B, 0x48, maxLimitOff]),
      Buffer.from([0x81, 0xF9]),
      packU32(DEFAULT_256K_TOKEN_LIMIT),
      Buffer.from([0x75, 0x0A]),
      Buffer.from([0x0F, 0x1F, 0x00]),
      Buffer.from([0xC7, 0x40, maxLimitOff]),
      packU32(contextLimit),
      Buffer.from([0x48, 0x89, 0x42, checkpointOff]),
      Buffer.from([0x31, 0xDB]),
      Buffer.from([0xE9]),
      packI32(jmpBackRel)
    ]);
  }
  if (trampAfter.length !== 46) {
    throw new Error(`Unexpected x86_64 trampoline length: ${trampAfter.length}`);
  }
  const chkEntryAfter = Buffer.from([0x31, 0xC0, 0x31, 0xDB, 0x31, 0xC9, 0xC3]);

  const ruleSites = [];
  const patBefore = Buffer.from([0xB9, 0xC0, 0x5D, 0x00, 0x00]);
  const patAfter = Buffer.from([0xB9, 0x00, 0x00, 0x10, 0x00]);
  for (const k of ['readGlobalRules', 'parseRuleFile', 'convertSkillPath']) {
    const fb = fbytes(k);
    const fInfo = funcs[k];
    const idxs = [];
    for (let i = 0; i <= fb.length - 5; i++) {
      const slice = fb.subarray(i, i + 5);
      if (slice.equals(patBefore) || slice.equals(patAfter)) {
        idxs.push(i);
      }
    }
    if (idxs.length !== 1) {
      throw new Error(`Expected 1 occurrence of 24000/1048576 mov ecx in ${k}, found ${idxs.length}`);
    }
    const rel = idxs[0];
    ruleSites.push([k, fInfo.va_start + rel, fInfo.file_start + rel, patBefore, patAfter]);
  }

  const fbTrunc = fbytes('computeTruncated');
  const fTrunc = funcs.computeTruncated;
  const r9ZeroBefore = Buffer.from([0x41, 0xB9, 0x00, 0x00, 0x00, 0x00]);
  const r9DefBefore = Buffer.from([0x41, 0xB9, 0x20, 0x4E, 0x00, 0x00]);
  const r9After = Buffer.from([0x41, 0xB9, 0x00, 0x00, 0x02, 0x00]);
  const r9Bridge = Buffer.from([0xEB, 0x09, 0x48, 0x85, 0xD2]);
  const edxZeroBefore = Buffer.from([0x31, 0xD2, 0xEB, 0x05, 0xBA, 0x20, 0x4E, 0x00, 0x00]);
  const edxAfter = Buffer.from([0xBA, 0x00, 0x00, 0x02, 0x00, 0x66, 0x0F, 0x1F, 0x00]);

  const r9PairIdxs = [];
  for (let i = 0; i <= fbTrunc.length - 17; i++) {
    const s1 = fbTrunc.subarray(i, i + 6);
    const s2 = fbTrunc.subarray(i + 6, i + 11);
    const s3 = fbTrunc.subarray(i + 11, i + 17);
    if (
      (s1.equals(r9ZeroBefore) || s1.equals(r9After)) &&
      s2.equals(r9Bridge) &&
      (s3.equals(r9DefBefore) || s3.equals(r9After))
    ) {
      r9PairIdxs.push(i);
    }
  }
  const edxIdxs = [];
  for (let i = 0; i <= fbTrunc.length - 9; i++) {
    const s = fbTrunc.subarray(i, i + 9);
    if (s.equals(edxZeroBefore) || s.equals(edxAfter)) {
      edxIdxs.push(i);
    }
  }
  if (r9PairIdxs.length !== 1 || edxIdxs.length !== 1) {
    throw new Error('Could not find 0x4e20 default assignments in computeTruncatedCustomizations');
  }
  const r9Rel = r9PairIdxs[0];
  const idxR9 = r9Rel + 11;
  const edxRel = edxIdxs[0];
  const idxEdx = edxRel + 4;

  const storeR9Disp32 = findInRange(fbTrunc, Buffer.from([0x44, 0x89, 0x8C, 0x24]), idxR9, idxR9 + 128);
  const storeEdxDisp32 = findInRange(fbTrunc, Buffer.from([0x89, 0x94, 0x24]), idxEdx, idxEdx + 64);
  const storeR9Disp8 = findInRange(fbTrunc, Buffer.from([0x44, 0x89, 0x4C, 0x24]), idxR9, idxR9 + 128);
  const storeEdxDisp8 = findInRange(fbTrunc, Buffer.from([0x89, 0x54, 0x24]), idxEdx, idxEdx + 64);

  let budgetSites;
  if (storeR9Disp32 !== -1 && storeEdxDisp32 !== -1) {
    const dispA = fbTrunc.subarray(storeR9Disp32 + 4, storeR9Disp32 + 8);
    const dispB = fbTrunc.subarray(storeEdxDisp32 + 3, storeEdxDisp32 + 7);
    const budget1Before = Buffer.concat([Buffer.from([0x8B, 0x9C, 0x24]), dispB]);
    const budget1After = Buffer.from([0xBB, 0x00, 0x00, 0x02, 0x00, 0x66, 0x90]);
    const budget2Before = Buffer.concat([Buffer.from([0x8B, 0x84, 0x24]), dispA]);
    const budget2After = Buffer.from([0xB8, 0x00, 0x00, 0x02, 0x00, 0x66, 0x90]);
    const movRcxRax = Buffer.from([0x48, 0x89, 0xC1]);
    const callMatches = [];
    for (let i = 0; i <= fbTrunc.length - 18; i++) {
      const p1 = fbTrunc.subarray(i, i + 7);
      const p2 = fbTrunc.subarray(i + 7, i + 10);
      const p3 = fbTrunc.subarray(i + 10, i + 17);
      if (
        (p1.equals(budget1Before) || p1.equals(budget1After)) &&
        p2.equals(movRcxRax) &&
        (p3.equals(budget2Before) || p3.equals(budget2After)) &&
        fbTrunc[i + 17] === 0xE8
      ) {
        callMatches.push(i);
      }
    }
    if (callMatches.length !== 1) {
      throw new Error(`Expected 1 budget call-site match in computeTruncatedCustomizations, found ${callMatches.length}`);
    }
    const cRel = callMatches[0];
    budgetSites = [
      ['customizations_budget', 'customizations token budget -> 131072', cRel, budget1Before, budget1After],
      ['rules_budget', 'rules token budget -> 131072', cRel + 10, budget2Before, budget2After]
    ];
  } else if (storeR9Disp8 !== -1 && storeEdxDisp8 !== -1) {
    budgetSites = [
      ['rules_budget_zero', 'rules token budget (zero fallback) -> 131072', r9Rel, r9ZeroBefore, r9After],
      ['rules_budget_default', 'rules token budget (default 20000) -> 131072', idxR9, r9DefBefore, r9After],
      ['customizations_budget', 'customizations token budget -> 131072', edxRel, edxZeroBefore, edxAfter]
    ];
  } else {
    throw new Error('Could not find stack slot stores for rules/customizations budgets');
  }

  const changes = [
    {
      name: 'applyOverride_exit',
      purpose: `applyFeatureProviderCheckpointOverrideConfig: jump to ${contextLimit} token context trampoline`,
      va: toHex(exitVa),
      offset: toHex(exitFoff),
      before: exitBefore.toString('hex'),
      after: exitAfter.toString('hex'),
      fixed_before: true
    },
    {
      name: 'trampolineHost_entry',
      purpose: `${fChk.symbol}: no-op return at entry`,
      va: toHex(chkVa),
      offset: toHex(chkFoff),
      before: data.subarray(chkFoff, chkFoff + chkEntryAfter.length).toString('hex'),
      after: chkEntryAfter.toString('hex'),
      fixed_before: false
    },
    {
      name: 'trampolineHost_trampoline',
      purpose: `${fChk.symbol}+0x20: universal 1M context max_token_limit=${contextLimit} trampoline`,
      va: toHex(trampVa),
      offset: toHex(trampFoff),
      before: data.subarray(trampFoff, trampFoff + trampAfter.length).toString('hex'),
      after: trampAfter.toString('hex'),
      fixed_before: false
    }
  ];

  for (const [k, va, foff, bBef, bAft] of ruleSites) {
    changes.push({
      name: `${k}_limit`,
      purpose: `${k}: per-file byte limit 24000 -> 1048576`,
      va: toHex(va),
      offset: toHex(foff),
      before: bBef.toString('hex'),
      after: bAft.toString('hex'),
      fixed_before: true
    });
  }
  for (const [bName, bDesc, bRel, bBef, bAft] of budgetSites) {
    changes.push({
      name: bName,
      purpose: `computeTruncatedCustomizations: ${bDesc}`,
      va: toHex(fTrunc.va_start + bRel),
      offset: toHex(fTrunc.file_start + bRel),
      before: bBef.toString('hex'),
      after: bAft.toString('hex'),
      fixed_before: true
    });
  }

  return {
    field_offsets: {
      planner: plannerOff,
      plan_model: planModelOff,
      max_token_limit: maxLimitOff,
      checkpoint: checkpointOff
    },
    changes
  };
}

function buildArm64Plan(img, funcs, contextLimit = DEFAULT_CONTEXT_LIMIT) {
  const data = img.data;
  const fbytes = (k) => {
    const f = funcs[k];
    return data.subarray(f.file_start, f.file_end);
  };

  const findLdrImm = (fb, mask, op, scale, name) => {
    for (let off = 0; off < fb.length - 3; off += 4) {
      const insn = fb.readUInt32LE(off);
      if (((insn & mask) >>> 0) === (op >>> 0)) {
        return ((insn >>> 10) & 0xFFF) * scale;
      }
    }
    throw new Error(`Could not decode field offset from ${name}`);
  };

  const plannerOff = findLdrImm(fbytes('GetPlannerConfig'), 0xFFC003FF, 0xF9400000, 8, 'GetPlannerConfig');
  const modelBytes = fbytes('GetPlanModel');
  let planModelOff;
  try {
    planModelOff = findLdrImm(modelBytes, 0xFFC003FF, 0xB9400000, 4, 'GetPlanModel');
  } catch {
    planModelOff = findLdrImm(modelBytes, 0xFFC003FF, 0xB9800000, 4, 'GetPlanModel');
  }
  const maxLimitOff = findLdrImm(fbytes('GetMaxTokenLimit'), 0xFFC003FF, 0xB9400000, 4, 'GetMaxTokenLimit');

  const bApply = fbytes('applyOverride');
  const fApply = funcs.applyOverride;
  const fChk = funcs.trampolineHost;
  if (fChk.file_end - fChk.file_start < HOST_SPAN[img.arch]) {
    throw new Error(`${fChk.symbol} is too small to host the trampoline`);
  }
  const chkVa = fChk.va_start;
  const chkFoff = fChk.file_start;
  const trampVa = chkVa + 0x20;
  const trampFoff = chkFoff + 0x20;

  const exitCandidates = [];
  const checkpointOff = 16;
  const layouts = [[0, 1, 3], [3, 0, 4]];
  for (let off = 0; off < bApply.length - 3; off += 4) {
    const insn = bApply.readUInt32LE(off);
    const va = fApply.va_start + off;
    const candDiff = trampVa - va;
    const bToTramp = (candDiff % 4 === 0 && Math.abs(candDiff) <= 0x7ffffff * 4 && candDiff >= -0x2000000 * 4 && candDiff <= 0x1FFFFFF * 4)
      ? (0x14000000 | (Math.trunc(candDiff / 4) & 0x03FFFFFF)) >>> 0
      : null;
    for (const [config, checkpoint, scratch] of layouts) {
      const store = (0xF9000000 | ((checkpointOff / 8) << 10) | (config << 5) | checkpoint) >>> 0;
      const suffix = [...(config === 3 ? [0xAA0303E0] : []), 0xAA1F03E1, 0xAA1F03E2];
      const expectedTail = packU32Array(suffix);
      if (
        (insn === store || (bToTramp !== null && insn === bToTramp)) &&
        bApply.subarray(off + 4, off + 4 + expectedTail.length).equals(expectedTail)
      ) {
        exitCandidates.push([off, config, checkpoint, scratch, store]);
      }
    }
  }
  if (exitCandidates.length !== 1) {
    throw new Error(`Expected 1 exit store in ARM64 applyOverride, found ${exitCandidates.length}`);
  }
  const [exitRel, config, checkpoint, scratch, checkpointStore] = exitCandidates[0];
  const exitVa = fApply.va_start + exitRel;
  const exitFoff = fApply.file_start + exitRel;

  if (!((trampVa - exitVa) % 4 === 0 && Math.abs(trampVa - exitVa) <= 0x7ffffff * 4)) {
    throw new Error('ARM64 trampoline out of 26-bit B range');
  }
  const wordDiff = Math.trunc((trampVa - exitVa) / 4);
  if (wordDiff < -0x2000000 || wordDiff > 0x1FFFFFF) {
    throw new Error('ARM64 trampoline out of 26-bit B range');
  }

  const returnDiff = (exitVa + 4) - (trampVa + 44);
  if (!(returnDiff % 4 === 0 && Math.abs(returnDiff) <= 0x7ffffff * 4)) {
    throw new Error('ARM64 trampoline return branch out of 26-bit B range');
  }
  const returnWordDiff = Math.trunc(returnDiff / 4);
  if (returnWordDiff < -0x2000000 || returnWordDiff > 0x1FFFFFF) {
    throw new Error('ARM64 trampoline return branch out of 26-bit B range');
  }

  const exitBefore = packU32(checkpointStore);
  const exitAfter = packU32((0x14000000 | (wordDiff & 0x03FFFFFF)) >>> 0);
  const chkEntryAfter = packU32Array([0xD2800000, 0xD2800001, 0xD2800002, 0xD65F03C0]);
  const trampInsns = [
    0xB4000140 | checkpoint,
    0xF9400000 | ((plannerOff / 8) << 10) | (config << 5) | scratch,
    0xB4000100 | scratch,
    0xB9400000 | ((maxLimitOff / 4) << 10) | (checkpoint << 5) | scratch,
    0x5140F800 | (scratch << 5) | scratch,
    0x7120001F | (scratch << 5),
    0x54000081,
    0x52800000 | ((contextLimit & 0xFFFF) << 5) | scratch,
    0x72A00000 | (((contextLimit >>> 16) & 0xFFFF) << 5) | scratch,
    0xB9000000 | ((maxLimitOff / 4) << 10) | (checkpoint << 5) | scratch,
    checkpointStore,
    0x14000000 | (returnWordDiff & 0x03FFFFFF)
  ];
  const trampAfter = packU32Array(trampInsns);

  const ruleSites = [];
  const patBefore = packU32(0xD28BB802);
  const patAfter = packU32(0xD2A00202);
  for (const k of ['readGlobalRules', 'parseRuleFile', 'convertSkillPath']) {
    const fb = fbytes(k);
    const fInfo = funcs[k];
    const idxs = [];
    for (let i = 0; i < fb.length - 3; i += 4) {
      const s = fb.subarray(i, i + 4);
      if (s.equals(patBefore) || s.equals(patAfter)) idxs.push(i);
    }
    if (idxs.length !== 1) {
      throw new Error(`Expected 1 occurrence of mov x2, #24000 in ${k}, found ${idxs.length}`);
    }
    const rel = idxs[0];
    ruleSites.push([k, fInfo.va_start + rel, fInfo.file_start + rel, patBefore, patAfter]);
  }

  const fbTrunc = fbytes('computeTruncated');
  const fTrunc = funcs.computeTruncated;
  const budgetSites = [];
  for (let off = 0x10; off < fbTrunc.length - 3; off += 4) {
    const insn = fbTrunc.readUInt32LE(off);
    const prevInsn = fbTrunc.readUInt32LE(off - 0x10);
    for (let rd = 0; rd < 31; rd++) {
      const mov20000 = (0xD289C400 | rd) >>> 0;
      const mov131072 = (0xD2A00040 | rd) >>> 0;
      const ldrswRd = (0xB9800000 | (rd << 5) | rd) >>> 0;
      if ((insn === mov20000 && prevInsn === ldrswRd) || (insn === mov131072 && prevInsn === mov131072)) {
        budgetSites.push([off - 0x10, packU32(ldrswRd), packU32(mov131072), `reg_x${rd}_cfg`]);
        budgetSites.push([off, packU32(mov20000), packU32(mov131072), `reg_x${rd}_def`]);
      }
    }
  }
  if (budgetSites.length !== 4) {
    throw new Error(`Expected 4 budget sites in ARM64 computeTruncatedCustomizations, found ${budgetSites.length}`);
  }

  const changes = [
    {
      name: 'applyOverride_exit',
      purpose: `applyFeatureProviderCheckpointOverrideConfig: branch to ${contextLimit} token context trampoline`,
      va: toHex(exitVa),
      offset: toHex(exitFoff),
      before: exitBefore.toString('hex'),
      after: exitAfter.toString('hex'),
      fixed_before: true
    },
    {
      name: 'trampolineHost_entry',
      purpose: `${fChk.symbol}: no-op return at entry`,
      va: toHex(chkVa),
      offset: toHex(chkFoff),
      before: data.subarray(chkFoff, chkFoff + chkEntryAfter.length).toString('hex'),
      after: chkEntryAfter.toString('hex'),
      fixed_before: false
    },
    {
      name: 'trampolineHost_trampoline',
      purpose: `${fChk.symbol}+0x20: universal 1M context max_token_limit=${contextLimit} trampoline`,
      va: toHex(trampVa),
      offset: toHex(trampFoff),
      before: data.subarray(trampFoff, trampFoff + trampAfter.length).toString('hex'),
      after: trampAfter.toString('hex'),
      fixed_before: false
    }
  ];
  for (const [k, va, foff, bBef, bAft] of ruleSites) {
    changes.push({
      name: `${k}_limit`,
      purpose: `${k}: per-file byte limit 24000 -> 1048576`,
      va: toHex(va),
      offset: toHex(foff),
      before: bBef.toString('hex'),
      after: bAft.toString('hex'),
      fixed_before: true
    });
  }
  for (const [rel, bBef, bAft, tag] of budgetSites) {
    changes.push({
      name: `budget_${tag}`,
      purpose: `computeTruncatedCustomizations (${tag}): token budget -> 131072`,
      va: toHex(fTrunc.va_start + rel),
      offset: toHex(fTrunc.file_start + rel),
      before: bBef.toString('hex'),
      after: bAft.toString('hex'),
      fixed_before: true
    });
  }

  return {
    field_offsets: {
      planner: plannerOff,
      plan_model: planModelOff,
      max_token_limit: maxLimitOff,
      checkpoint: checkpointOff
    },
    changes
  };
}

function manifestHash(val) {
  return typeof val === 'string' && /^[0-9a-fA-F]{64}$/.test(val) ? val.toLowerCase() : '';
}

function selectRestoreBackup(targetPath, backupDir = DEFAULT_BACKUP_DIR, currentSha256 = null) {
  const target = path.resolve(targetPath);
  const current = currentSha256 || sha256Hex(fs.readFileSync(target));
  const targetResolved = resolveCanonical(target);
  if (!fs.existsSync(backupDir)) {
    throw new Error(`No verified matching backup for ${target} in ${backupDir}`);
  }
  const baseName = path.basename(target);
  const files = fs.readdirSync(backupDir)
    .filter((f) => f.startsWith(`${baseName}-`) && f.includes('-manifest-') && f.endsWith('.json'))
    .sort()
    .reverse();

  let corruptedMatch = null;
  for (const file of files) {
    const manifestPath = path.join(backupDir, file);
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (!manifest || typeof manifest !== 'object') throw new Error('Manifest must be an object');
      const original = manifestHash(manifest.sha256);
      if (!original) throw new Error('Invalid original SHA256');
      const backupPath = manifest.backup_path ? path.resolve(manifest.backup_path) : null;
      if (!backupPath || !fs.existsSync(backupPath) || sha256Hex(fs.readFileSync(backupPath)) !== original) {
        throw new Error('Backup missing or hash mismatch');
      }
      if (current === manifest.patched_sha256 || current === original) {
        return { manifestPath, manifest, backupPath };
      }
      const recordedResolved = typeof manifest.path === 'string' && manifest.path
        ? resolveCanonical(manifest.path)
        : null;
      const corruptedSha = manifestHash(manifest.corrupted_disk_sha256);
      if (
        corruptedMatch === null &&
        targetResolved !== null &&
        recordedResolved !== null &&
        normcasePath(recordedResolved) === normcasePath(targetResolved) &&
        manifest.interrupted_write === true &&
        corruptedSha &&
        current === corruptedSha
      ) {
        corruptedMatch = { manifestPath, manifest, backupPath };
      }
    } catch {
      // Skip invalid manifests
    }
  }
  if (corruptedMatch) return corruptedMatch;
  throw new Error(`No verified matching backup for ${target} in ${backupDir}`);
}

function recordedHashRole(targetPath, sha256, backupDir) {
  if (backupDir === false) return null;
  const bdir = typeof backupDir === 'string' ? backupDir : DEFAULT_BACKUP_DIR;
  if (!fs.existsSync(bdir)) return null;
  const baseName = path.basename(targetPath);
  const files = fs.readdirSync(bdir)
    .filter((f) => f.startsWith(`${baseName}-`) && f.includes('manifest') && f.endsWith('.json'))
    .sort();
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(bdir, f), 'utf8'));
      if (data && typeof data === 'object') {
        if (data.sha256 === sha256) return 'original';
        if (data.patched_sha256 === sha256) return 'patched';
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function tryUpgradeFromVerifiedBackup(targetPath, sha256, backupDir, contextLimit) {
  if (backupDir === false) return null;
  const bdir = typeof backupDir === 'string' ? backupDir : DEFAULT_BACKUP_DIR;
  if (!fs.existsSync(bdir)) return null;
  try {
    const { manifest, backupPath } = selectRestoreBackup(targetPath, bdir, sha256);
    const bakResolved = resolveCanonical(backupPath);
    const targetResolved = resolveCanonical(targetPath);
    if (
      sha256 === manifest.patched_sha256 &&
      bakResolved &&
      targetResolved &&
      normcasePath(bakResolved) !== normcasePath(targetResolved)
    ) {
      const bakInfo = analyzeBinary(backupPath, { backupDir: false, contextLimit });
      if (bakInfo.status === 'UNPATCHED') {
        bakInfo.path = path.resolve(targetPath);
        bakInfo.target_disk_sha256 = sha256;
        bakInfo.upgrade_from_backup = backupPath;
        return bakInfo;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function formatFunctionsReport(funcs) {
  const out = {};
  for (const [k, v] of Object.entries(funcs)) {
    const item = {};
    for (const [fk, fv] of Object.entries(v)) {
      item[fk] = typeof fv === 'number' ? toHex(fv) : fv;
    }
    out[k] = item;
  }
  return out;
}

function analyzeBinary(targetPath, options = {}) {
  const target = path.resolve(targetPath);
  const backupDir = options.backupDir !== undefined ? options.backupDir : DEFAULT_BACKUP_DIR;
  const contextLimit = options.contextLimit !== undefined ? options.contextLimit : null;

  const data = fs.readFileSync(target);
  const sha256 = sha256Hex(data);
  const img = new BinaryImage(data);
  const { pclnOff, goTextVa, funcs: baseFuncs, hosts } = locateGoFunctions(img);

  let funcs;
  let hostAmbiguous;
  let selectedLimit;
  let plan;
  try {
    const chosen = chooseTrampolineHost(img, baseFuncs, hosts, goTextVa);
    hostAmbiguous = chosen.hostAmbiguous;
    funcs = { ...baseFuncs, trampolineHost: chosen.host };
    selectedLimit = contextLimit || DEFAULT_CONTEXT_LIMIT;
    if (contextLimit === null) {
      const start = chosen.host.file_start;
      const noop = HOST_NOOP_ENTRY[img.arch];
      if (data.subarray(start, start + noop.length).equals(noop)) {
        const trampoline = start + 0x20;
        let candidate;
        if (img.arch === 'x86_64') {
          candidate = data.readUInt32LE(trampoline + 31);
        } else {
          const low = data.readUInt32LE(trampoline + 28);
          const high = data.readUInt32LE(trampoline + 32);
          candidate = (((low >>> 5) & 0xFFFF) | (((high >>> 5) & 0xFFFF) << 16)) >>> 0;
        }
        if (candidate > DEFAULT_256K_TOKEN_LIMIT && candidate <= MAX_CONTEXT_LIMIT) {
          selectedLimit = candidate;
        }
      }
    }
    plan = img.arch === 'x86_64'
      ? buildX86_64Plan(img, funcs, selectedLimit)
      : buildArm64Plan(img, funcs, selectedLimit);
  } catch (err) {
    const upgraded = tryUpgradeFromVerifiedBackup(target, sha256, backupDir, contextLimit);
    if (upgraded !== null) return upgraded;
    throw err;
  }

  let allAfter = true;
  let allFixedBefore = true;
  for (const c of plan.changes) {
    const off = parseInt(c.offset, 16);
    const aft = Buffer.from(c.after, 'hex');
    const bef = Buffer.from(c.before, 'hex');
    const cur = data.subarray(off, off + aft.length);
    if (!cur.equals(aft)) allAfter = false;
    if (c.fixed_before && !cur.equals(bef)) allFixedBefore = false;
  }

  const checkpointNeededIntact = validCheckpointEntry(img, funcs.checkpointNeeded);
  let status;
  if (allAfter && checkpointNeededIntact) {
    status = 'ALREADY_PATCHED';
  } else if (allFixedBefore && checkpointNeededIntact) {
    const entry = plan.changes.find((c) => c.name === 'trampolineHost_entry');
    const trampoline = plan.changes.find((c) => c.name === 'trampolineHost_trampoline');
    const entryAfter = Buffer.from(entry.after, 'hex');
    const entryAt = parseInt(entry.offset, 16);
    const originalEntry = (
      !data.subarray(entryAt, entryAt + entryAfter.length).equals(entryAfter) &&
      (!hostAmbiguous || backupDir === false || recordedHashRole(target, sha256, backupDir) === 'original')
    );
    let partial = false;
    for (const change of [entry, trampoline]) {
      const current = Buffer.from(change.before, 'hex');
      const patched = Buffer.from(change.after, 'hex');
      if (img.arch === 'arm64') {
        const excluded = change === trampoline ? new Set([40]) : new Set();
        for (let i = 0; i < patched.length; i += 4) {
          if (!excluded.has(i) && current.subarray(i, i + 4).equals(patched.subarray(i, i + 4))) {
            partial = true;
            break;
          }
        }
      } else if (current.equals(patched) || current.subarray(0, 5).equals(patched.subarray(0, 5))) {
        partial = true;
      }
    }
    status = originalEntry && !partial ? 'UNPATCHED' : 'UNKNOWN_OR_PARTIAL';
  } else {
    status = 'UNKNOWN_OR_PARTIAL';
  }

  if (status === 'UNKNOWN_OR_PARTIAL') {
    const upgraded = tryUpgradeFromVerifiedBackup(target, sha256, backupDir, contextLimit);
    if (upgraded !== null) return upgraded;
  }

  return {
    path: target,
    format: img.fmt,
    arch: img.arch,
    size: data.length,
    sha256,
    pclntab_offset: toHex(pclnOff),
    go_text_va: toHex(goTextVa),
    status,
    context_limit: selectedLimit,
    host_entry: hostAmbiguous ? 'unverified' : 'recognised',
    backup_scope: 'Pre-patch bytes; instruction validation is not vendor authenticity verification.',
    field_offsets: plan.field_offsets,
    functions: formatFunctionsReport(funcs),
    changes: plan.changes
  };
}

function updateAgySidecarIfPresent(targetPath) {
  const sidecar = path.join(path.dirname(targetPath), 'agy.version.json');
  if (!fs.existsSync(sidecar)) return;
  const tmp = `${sidecar}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    const meta = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    const st = fs.statSync(targetPath);
    meta.size = st.size;
    meta.mtimeMs = st.mtimeMs;
    meta.ino = 0;
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, sidecar);
  } catch {
    // non-fatal
  } finally {
    if (fs.existsSync(tmp)) {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }
}

function getBinaryVersion(targetPath) {
  for (const flag of ['--stamp', '--version']) {
    try {
      const res = spawnSync(String(targetPath), [flag], {
        encoding: 'utf8',
        timeout: 3000,
        windowsHide: true
      });
      if (res.status !== 0) continue;
      const out = `${res.stdout || ''}\n${res.stderr || ''}`.trim();
      if (out) {
        const lines = out.split(/\r?\n/);
        for (const line of lines) {
          if (line.includes('Built at CL:')) {
            const cl = 'CL' + line.split('Built at CL:').pop().trim();
            return cl.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48) || 'unknown';
          }
        }
        const first = lines[0].trim().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 48);
        if (first) return first;
      }
    } catch {
      // ignore
    }
  }
  return 'unknown';
}

function uniqueTargets(paths) {
  const seen = new Map();
  for (const p of paths) {
    if (!p) continue;
    const resolved = resolveCanonical(p) || path.resolve(p);
    const key = normcasePath(resolved);
    if (!seen.has(key)) seen.set(key, resolved);
  }
  return Array.from(seen.values());
}

function discoverDefaultTargets() {
  const home = os.homedir();
  const names = process.platform === 'win32'
    ? ['agy.exe', 'language_server.exe']
    : [
        'agy', 'language_server', 'language_server_macos_arm', 'language_server_macos_arm64',
        'language_server_macos', 'language_server_linux_x64', 'language_server_linux_arm',
        'language_server_linux_arm64'
      ];
  const candidates = [
    path.join(home, '.gemini', 'bin', names[0]),
    path.join(home, '.local', 'bin', names[0])
  ];
  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    if (entry) {
      for (const name of names) candidates.push(path.join(entry, name));
    }
  }
  const roots = [];
  if (process.platform === 'win32') {
    roots.push(path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs'));
    if (process.env.ProgramFiles) roots.push(process.env.ProgramFiles);
    if (process.env['ProgramFiles(x86)']) roots.push(process.env['ProgramFiles(x86)']);
  } else if (process.platform === 'darwin') {
    roots.push('/Applications', path.join(home, 'Applications'));
  } else {
    roots.push('/opt', '/usr/share', '/usr/lib', path.join(home, '.local', 'share'));
  }
  for (const root of roots) {
    try {
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.toLowerCase().includes('antigravity')) continue;
        const product = path.join(root, entry.name);
        const resources = entry.name.toLowerCase().endsWith('.app')
          ? path.join(product, 'Contents', 'Resources')
          : path.join(product, 'resources');
        const locations = [
          product,
          path.join(product, 'bin'),
          path.join(resources, 'bin'),
          path.join(resources, 'app', 'bin'),
          path.join(resources, 'app', 'extensions', 'antigravity', 'bin'),
          path.join(resources, 'app', 'extensions', 'agy', 'bin')
        ];
        for (const loc of locations) {
          for (const name of names) candidates.push(path.join(loc, name));
        }
      }
    } catch {
      // ignore inaccessible roots
    }
  }
  return uniqueTargets(candidates.filter((c) => {
    try {
      return fs.statSync(c).isFile();
    } catch {
      return false;
    }
  }));
}

function windowsSystemExe(subPath) {
  const sysRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return path.join(sysRoot, 'System32', subPath);
}

function runningBackends(targets) {
  const list = Array.isArray(targets) ? targets : [];
  if (list.length === 0) return [];
  const names = new Set(list.map((t) => path.basename(t).toLowerCase()));
  const fullPaths = new Set(
    list
      .filter((t) => path.isAbsolute(String(t)))
      .map((t) => normcasePath(resolveCanonical(t) || path.resolve(t)))
  );
  const matchesTarget = (exePath, exeName) => {
    if (exePath) {
      const resolved = normcasePath(resolveCanonical(exePath) || path.resolve(exePath));
      if (fullPaths.size > 0) return fullPaths.has(resolved);
    }
    return fullPaths.size === 0 && Boolean(exeName) && names.has(String(exeName).toLowerCase());
  };

  if (process.platform === 'win32') {
    const psExe = windowsSystemExe(path.join('WindowsPowerShell', 'v1.0', 'powershell.exe'));
    const psRes = spawnSync(
      psExe,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath | ConvertTo-Json -Compress'
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 }
    );
    if (psRes.status === 0 && psRes.stdout && psRes.stdout.trim()) {
      try {
        const parsed = JSON.parse(psRes.stdout.trim());
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        const found = [];
        for (const p of rows) {
          if (!p || !Number.isInteger(p.ProcessId) || p.ProcessId === process.pid) continue;
          if (matchesTarget(p.ExecutablePath, p.Name)) {
            found.push({
              pid: p.ProcessId,
              name: p.Name || path.basename(p.ExecutablePath || ''),
              path: p.ExecutablePath || undefined
            });
          }
        }
        return found;
      } catch {}
    }

    const res = spawnSync(windowsSystemExe('tasklist.exe'), ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    if (res.status !== 0 || !res.stdout) return [];
    const found = [];
    for (const line of res.stdout.split(/\r?\n/)) {
      const m = line.match(/^"([^"]+)","(\d+)"/);
      if (m && names.has(m[1].toLowerCase())) {
        const pid = parseInt(m[2], 10);
        if (pid !== process.pid) found.push({ pid, name: m[1] });
      }
    }
    return found;
  }

  const readLinuxProcExe = (pid) => {
    if (process.platform !== 'linux') return null;
    try {
      const raw = fs.readlinkSync('/proc/' + pid + '/exe');
      return raw ? raw.replace(/ \(deleted\)$/, '') : null;
    } catch {
      return null;
    }
  };

  const psArgsRes = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  if (psArgsRes.status === 0 && psArgsRes.stdout) {
    const found = [];
    for (const line of psArgsRes.stdout.split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = parseInt(m[1], 10);
      if (pid === process.pid) continue;
      const cmdline = m[2].trim();
      let matchedPath = null;
      const procExe = readLinuxProcExe(pid);
      if (procExe && matchesTarget(procExe, path.basename(procExe))) {
        matchedPath = procExe;
      }
      if (!matchedPath && fullPaths.size > 0) {
        for (const t of list) {
          const canon = resolveCanonical(t) || path.resolve(t);
          for (const candidate of [t, canon]) {
            if (cmdline === candidate || cmdline.startsWith(candidate + ' ')) {
              matchedPath = candidate;
              break;
            }
          }
          if (matchedPath) break;
        }
      }
      if (!matchedPath) {
        const argv0 = cmdline.split(/\s+/)[0];
        if (matchesTarget(path.isAbsolute(argv0) ? argv0 : null, path.basename(argv0))) {
          matchedPath = argv0;
        }
      }
      if (matchedPath) {
        found.push({ pid, name: path.basename(matchedPath), path: matchedPath });
      }
    }
    return found;
  }

  if (process.platform === 'linux') {
    try {
      const found = [];
      for (const entry of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = parseInt(entry, 10);
        if (pid === process.pid) continue;
        const procExe = readLinuxProcExe(pid);
        if (procExe && matchesTarget(procExe, path.basename(procExe))) {
          found.push({ pid, name: path.basename(procExe), path: procExe });
        }
      }
      return found;
    } catch {}
  }

  const res = spawnSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' });
  if (res.status !== 0 || !res.stdout) return [];
  const found = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (m && names.has(path.basename(m[2]).toLowerCase())) {
      const pid = parseInt(m[1], 10);
      if (pid !== process.pid) found.push({ pid, name: path.basename(m[2]) });
    }
  }
  return found;
}

const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));
function sleepBoundedMs(ms) {
  const waitMs = Math.max(0, Math.min(2000, Math.trunc(Number(ms) || 0)));
  if (waitMs > 0) {
    Atomics.wait(SLEEP_ARRAY, 0, 0, waitMs);
  }
}

function killRunningBackends(targets) {
  const active = runningBackends(targets);
  if (active.length === 0) return;
  const taskkillExe = process.platform === 'win32' ? windowsSystemExe('taskkill.exe') : null;
  for (const proc of active) {
    if (process.platform === 'win32') {
      spawnSync(taskkillExe, ['/F', '/PID', String(proc.pid)], { windowsHide: true });
    } else {
      try {
        process.kill(proc.pid, 'SIGTERM');
      } catch {
        // ignore
      }
    }
  }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (runningBackends(targets).length === 0) return;
    sleepBoundedMs(Math.min(100, Math.max(1, deadline - Date.now())));
  }
}

function writeFileAtomic(filePath, content) {
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`
  );
  try {
    const fd = fs.openSync(tmpPath, 'w');
    try {
      if (Buffer.isBuffer(content)) {
        fs.writeFileSync(fd, content);
      } else {
        fs.writeFileSync(fd, content, 'utf8');
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
  } finally {
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }
}

function writeManifest(manifestPath, report) {
  const content = Buffer.isBuffer(report) ? report : (JSON.stringify(report, null, 2) + '\n');
  writeFileAtomic(manifestPath, content);
}

function ensureBackendNotRunning(targetPath, opts = {}) {
  if (opts && opts.allowRunning === true) return;
  const resolved = path.resolve(targetPath);
  const active = runningBackends([resolved]);
  if (active.length > 0) {
    const procDesc = active
      .map((p) => `${p.name || path.basename(resolved)} (PID=${p.pid})`)
      .join(', ');
    throw new Error(
      `Cannot modify running backend binary ${resolved}: ${procDesc}. Close Antigravity first or pass --kill.`
    );
  }
}

function replaceAtomicOrOverwrite(tmpPath, targetPath, expectedSha256, rollbackBytes) {
  try {
    if (sha256Hex(fs.readFileSync(targetPath)) !== expectedSha256) {
      throw new Error(`Backend changed before replacement: ${targetPath}; rerun the check`);
    }
    try {
      fs.renameSync(tmpPath, targetPath);
      return;
    } catch (err) {
      // Never mutate in-place on darwin/linux (in-place Mach-O writes corrupt Apple Silicon
      // kernel code-signing page cache and trigger SIGKILL). Only fall back on win32 EACCES/EPERM.
      const allowWin32InPlace = (
        process.platform === 'win32' &&
        Boolean(rollbackBytes) &&
        Boolean(err) &&
        (err.code === 'EACCES' || err.code === 'EPERM')
      );
      if (!allowWin32InPlace) {
        throw err;
      }
      const payload = fs.readFileSync(tmpPath);
      try {
        const fd = fs.openSync(targetPath, 'r+');
        try {
          fs.writeFileSync(fd, payload, 0, payload.length, 0);
          fs.ftruncateSync(fd, payload.length);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        if (sha256Hex(fs.readFileSync(targetPath)) !== sha256Hex(payload)) {
          throw new Error(`in-place write of ${targetPath} did not verify`);
        }
        return;
      } catch (writeErr) {
        try {
          const fd = fs.openSync(targetPath, 'r+');
          try {
            fs.writeFileSync(fd, rollbackBytes, 0, rollbackBytes.length, 0);
            fs.ftruncateSync(fd, rollbackBytes.length);
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }
        } catch {}
        throw writeErr;
      }
    }
  } finally {
    if (tmpPath && fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }
}

function patchTarget(targetPath, options = {}) {
  const target = path.resolve(targetPath);
  const backupDir = path.resolve(options.backupDir || DEFAULT_BACKUP_DIR);
  const dryRun = Boolean(options.dryRun);
  const targetLimit = options.contextLimit !== undefined && options.contextLimit !== null
    ? parseContextLimit(options.contextLimit)
    : DEFAULT_CONTEXT_LIMIT;

  if (!fs.existsSync(target)) {
    fs.readFileSync(target);
  }
  if (dryRun) {
    return analyzeBinary(target, { backupDir, contextLimit: targetLimit });
  }

  ensureBackendNotRunning(target, options);

  const info = analyzeBinary(target, { backupDir, contextLimit: targetLimit });
  if (info.status === 'ALREADY_PATCHED') {
    updateAgySidecarIfPresent(target);
    return info;
  }
  if (info.status !== 'UNPATCHED') {
    throw new Error(`Refusing to patch ${target}: binary state is ${info.status}`);
  }

  const ver = getBinaryVersion(target);
  fs.mkdirSync(backupDir, { recursive: true });
  const baseName = path.basename(target);
  const backupFile = path.join(backupDir, `${baseName}-${ver}-original-${info.sha256.slice(0, 16)}.bak`);
  const targetDiskSha256 = info.target_disk_sha256 || info.sha256;

  const rollbackBytes = fs.readFileSync(target);
  if (sha256Hex(rollbackBytes) !== targetDiskSha256) {
    throw new Error('Backend changed during analysis; rerun before patching');
  }
  const rawBytes = info.upgrade_from_backup
    ? fs.readFileSync(info.upgrade_from_backup)
    : rollbackBytes;
  if (sha256Hex(rawBytes) !== info.sha256) {
    throw new Error('Original source bytes failed SHA256 verification');
  }

  if (fs.existsSync(backupFile)) {
    const bakSha = sha256Hex(fs.readFileSync(backupFile));
    if (bakSha !== info.sha256) {
      throw new Error(`Backup file ${backupFile} exists with different SHA256!`);
    }
  } else {
    const fd = fs.openSync(backupFile, 'wx');
    try {
      fs.writeFileSync(fd, rawBytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  if (sha256Hex(fs.readFileSync(backupFile)) !== info.sha256) {
    throw new Error('Original backup failed SHA256 verification');
  }

  const out = Buffer.from(rawBytes);
  for (const c of info.changes) {
    const off = parseInt(c.offset, 16);
    const bef = Buffer.from(c.before, 'hex');
    const aft = Buffer.from(c.after, 'hex');
    if (bef.length !== aft.length) {
      throw new Error(`Patch length mismatch at ${c.offset}`);
    }
    if (!out.subarray(off, off + bef.length).equals(bef)) {
      throw new Error(`Byte mismatch at ${c.offset} (${c.purpose})`);
    }
    aft.copy(out, off);
  }

  info.backup_path = backupFile;
  info.version = ver;

  const resolvedTarget = resolveCanonical(target) || target;
  const pathTag = crypto.createHash('sha256').update(normcasePath(resolvedTarget), 'utf8').digest('hex').slice(0, 8);
  const tmpPath = path.join(path.dirname(target), `.${baseName}-patch-${process.pid}-${Date.now()}`);

  let manifestFile;
  try {
    const fd = fs.openSync(tmpPath, 'wx');
    try {
      fs.writeFileSync(fd, out);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const mode = fs.statSync(target).mode & 0o777;
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(tmpPath, mode);
      } catch (chmodErr) {
        throw new Error(`Failed to preserve executable permissions on ${tmpPath}: ${chmodErr.message}`);
      }
    } else {
      try { fs.chmodSync(tmpPath, mode); } catch {}
    }

    if (info.format === 'Mach-O') {
      if (process.platform !== 'darwin') {
        throw new Error('Mach-O patching requires macOS codesign');
      }
      const signRes = spawnSync(
        '/usr/bin/codesign',
        ['--force', '--sign', '-', '--identifier', path.basename(targetPath), tmpPath],
        { encoding: 'utf8', stdio: 'pipe' }
      );
      if (signRes.error || signRes.status !== 0) {
        const detail = signRes.error ? signRes.error.message : (signRes.stderr || signRes.stdout || `exit ${signRes.status}`).trim();
        throw new Error(`macOS codesign failed: ${detail}`);
      }
      const verifyRes = spawnSync('/usr/bin/codesign', ['--verify', '--strict', tmpPath], { encoding: 'utf8', stdio: 'pipe' });
      if (verifyRes.error || verifyRes.status !== 0) {
        const detail = verifyRes.error ? verifyRes.error.message : (verifyRes.stderr || verifyRes.stdout || `exit ${verifyRes.status}`).trim();
        throw new Error(`macOS codesign verification failed: ${detail}`);
      }
      const signedInfo = analyzeBinary(tmpPath, { backupDir: false, contextLimit: targetLimit });
      if (signedInfo.status !== 'ALREADY_PATCHED' || signedInfo.context_limit !== targetLimit) {
        throw new Error('Signed binary failed patch verification');
      }
    }

    const patchedSha256 = sha256Hex(fs.readFileSync(tmpPath));
    info.patched_sha256 = patchedSha256;
    info.patched_size = fs.statSync(tmpPath).size;
    manifestFile = path.join(
      backupDir,
      `${baseName}-${ver}-manifest-${info.sha256.slice(0, 16)}-${pathTag}-${patchedSha256.slice(0, 16)}.json`
    );
    const previousManifest = fs.existsSync(manifestFile) ? fs.readFileSync(manifestFile) : null;
    writeManifest(manifestFile, info);

    try {
      replaceAtomicOrOverwrite(tmpPath, target, targetDiskSha256, rollbackBytes);
    } catch (err) {
      let diskNowSha = null;
      try {
        diskNowSha = sha256Hex(fs.readFileSync(target));
      } catch {}
      if (diskNowSha === targetDiskSha256) {
        if (previousManifest === null) {
          try { fs.unlinkSync(manifestFile); } catch {}
        } else {
          writeManifest(manifestFile, previousManifest);
        }
      } else if (diskNowSha !== patchedSha256) {
        info.interrupted_write = true;
        if (diskNowSha) info.corrupted_disk_sha256 = diskNowSha;
        try { writeManifest(manifestFile, info); } catch {}
      }
      throw err;
    }
  } finally {
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }

  updateAgySidecarIfPresent(target);
  const postVerifyInfo = analyzeBinary(target, { backupDir, contextLimit: targetLimit });
  if (
    postVerifyInfo.status !== 'ALREADY_PATCHED' ||
    postVerifyInfo.context_limit !== targetLimit ||
    info.context_limit !== targetLimit
  ) {
    throw new Error(`Post-write patch verification failed for ${target}; original backup: ${backupFile}`);
  }
  info.manifest_path = manifestFile;
  info.status = 'PATCHED';
  return info;
}

function restoreTarget(targetPath, options = {}) {
  const target = path.resolve(targetPath);
  const backupDir = path.resolve(options.backupDir || DEFAULT_BACKUP_DIR);
  if (!fs.existsSync(target)) {
    fs.readFileSync(target);
  }
  ensureBackendNotRunning(target, options);
  const beforeBytes = fs.readFileSync(target);
  const beforeSha256 = sha256Hex(beforeBytes);
  const { manifestPath, manifest, backupPath } = selectRestoreBackup(target, backupDir, beforeSha256);
  const bakBytes = fs.readFileSync(backupPath);
  if (sha256Hex(bakBytes) !== manifest.sha256) {
    throw new Error(`Backup hash mismatch: ${backupPath}`);
  }
  const baseName = path.basename(target);
  const tmpPath = path.join(path.dirname(target), `.${baseName}-restore-${process.pid}-${Date.now()}`);
  try {
    const fd = fs.openSync(tmpPath, 'wx');
    try {
      fs.writeFileSync(fd, bakBytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const mode = fs.statSync(target).mode & 0o777;
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(tmpPath, mode);
      } catch (chmodErr) {
        throw new Error(`Failed to preserve executable permissions on ${tmpPath}: ${chmodErr.message}`);
      }
    } else {
      try { fs.chmodSync(tmpPath, mode); } catch {}
    }
    replaceAtomicOrOverwrite(tmpPath, target, beforeSha256, beforeBytes);
  } finally {
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }
  updateAgySidecarIfPresent(target);
  if (sha256Hex(fs.readFileSync(target)) !== manifest.sha256) {
    throw new Error(`Restored file hash mismatch: ${target}`);
  }
  if (manifest.interrupted_write || 'corrupted_disk_sha256' in manifest) {
    const cleaned = { ...manifest };
    delete cleaned.interrupted_write;
    delete cleaned.corrupted_disk_sha256;
    try { writeManifest(manifestPath, cleaned); } catch {}
  }
  return {
    path: target,
    operation: 'restore',
    status: 'RESTORED',
    before_sha256: beforeSha256,
    restored_sha256: manifest.sha256,
    backup_path: backupPath,
    manifest_path: manifestPath
  };
}

function pruneOldBackups(backupDir = DEFAULT_BACKUP_DIR, targets = []) {
  const base = resolveCanonical(backupDir);
  if (!base || !fs.existsSync(base) || !fs.statSync(base).isDirectory()) return [];

  const installed = new Set();
  const current = new Map();
  const pathHash = new Map();
  for (const t of targets) {
    const resolved = resolveCanonical(t);
    if (!resolved) continue;
    try {
      const digest = sha256Hex(fs.readFileSync(resolved));
      const key = normcasePath(resolved);
      const name = path.basename(resolved);
      if (!current.has(name)) current.set(name, new Set());
      current.get(name).add(digest);
      pathHash.set(key, digest);
      installed.add(key);
    } catch {}
  }

  const entries = [];
  for (const file of fs.readdirSync(base).filter((f) => f.includes('manifest') && f.endsWith('.json')).sort()) {
    const mPath = path.join(base, file);
    try {
      const data = JSON.parse(fs.readFileSync(mPath, 'utf8'));
      if (data && typeof data === 'object') entries.push([mPath, data]);
    } catch {}
  }

  const keep = new Set();
  const stale = [];
  for (const [manifest, data] of entries) {
    const prefixName = path.basename(manifest).split('-', 1)[0];
    const hashes = current.get(prefixName);
    const backupPath = typeof data.backup_path === 'string' && data.backup_path ? path.resolve(data.backup_path) : null;
    if (!hashes) {
      keep.add(manifest);
      if (backupPath) keep.add(backupPath);
      continue;
    }
    const original = manifestHash(data.sha256);
    const patched = manifestHash(data.patched_sha256);
    const recordedResolved = typeof data.path === 'string' && data.path ? resolveCanonical(data.path) : null;
    const recordedKey = recordedResolved ? normcasePath(recordedResolved) : null;
    if (!(original && patched && recordedKey && installed.has(recordedKey))) {
      keep.add(manifest);
      if (backupPath) keep.add(backupPath);
      continue;
    }
    const installedDigest = pathHash.get(recordedKey);
    if (installedDigest === patched || installedDigest === original) {
      keep.add(manifest);
      if (backupPath) keep.add(backupPath);
    } else {
      stale.push([manifest, backupPath]);
    }
  }

  const keepResolved = new Set();
  for (const p of keep) {
    const r = resolveCanonical(p);
    if (r) keepResolved.add(normcasePath(r));
  }

  const removed = [];
  const baseNorm = normcasePath(base) + path.sep;
  for (const [manifest, backupPath] of stale) {
    for (const p of [backupPath, manifest]) {
      if (!p) continue;
      const resolved = resolveCanonical(p);
      if (!resolved) continue;
      const rNorm = normcasePath(resolved);
      if (!rNorm.startsWith(baseNorm) || keepResolved.has(rNorm)) continue;
      try {
        if (fs.lstatSync(p).isSymbolicLink() || !fs.statSync(resolved).isFile()) continue;
        const size = fs.statSync(resolved).size;
        fs.unlinkSync(p);
        removed.push({ path: p, size });
      } catch {
        break;
      }
    }
  }
  return removed;
}

function parseContextLimit(value) {
  if (typeof value === 'string' && !value.trim()) {
    throw new Error(`Context limit must be an integer between ${DEFAULT_256K_TOKEN_LIMIT + 1} and ${MAX_CONTEXT_LIMIT}`);
  }
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= DEFAULT_256K_TOKEN_LIMIT || limit > MAX_CONTEXT_LIMIT) {
    throw new Error(`Context limit must be an integer between ${DEFAULT_256K_TOKEN_LIMIT + 1} and ${MAX_CONTEXT_LIMIT}`);
  }
  return limit;
}

function printCliUsage() {
  console.log([
    'Usage: node core/backend-patcher.cjs [options]',
    '',
    'Options:',
    '  --target <path>          Path to agy / language_server binary (repeatable; defaults to auto-discovery)',
    `  --context-limit <tokens> Auto-compaction budget (${DEFAULT_256K_TOKEN_LIMIT + 1}..${MAX_CONTEXT_LIMIT}, default: ${DEFAULT_CONTEXT_LIMIT})`,
    `  --backup-dir <dir>       Directory for original backups and manifests (default: ${DEFAULT_BACKUP_DIR})`,
    '  --check, --dry-run       Read-only compatibility & status check without modifying binaries',
    '  --status                 Alias for --check',
    '  --restore                Restore original unpatched binary from verified backup',
    '  --kill                   Terminate running target backend processes before patching/restoring',
    '  --json                   Emit machine-readable JSON output on stdout',
    '  -h, --help               Show this help message and exit'
  ].join('\n'));
}

function readRequiredFlagValue(args, index, flagName) {
  if (index + 1 >= args.length) {
    throw new Error(`Missing required value after ${flagName}`);
  }
  const val = String(args[index + 1]);
  if (!val.trim() || val.startsWith('--') || val === '-h') {
    throw new Error(`Missing or invalid value after ${flagName}: ${val || '(empty)'}`);
  }
  return val;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    printCliUsage();
    process.exit(0);
  }

  let dryRun = false;
  let restore = false;
  let kill = false;
  const jsonOut = args.includes('--json');
  let contextLimit = null;
  let backupDir = DEFAULT_BACKUP_DIR;
  const targetArgs = [];

  try {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--check' || a === '--dry-run' || a === '--status') {
        dryRun = true;
      } else if (a === '--restore') {
        restore = true;
      } else if (a === '--kill') {
        kill = true;
      } else if (a === '--json') {
        continue;
      } else if (a === '--context-limit') {
        const raw = readRequiredFlagValue(args, i, '--context-limit');
        i++;
        contextLimit = parseContextLimit(raw);
      } else if (a === '--backup-dir') {
        const raw = readRequiredFlagValue(args, i, '--backup-dir');
        i++;
        backupDir = path.resolve(raw);
      } else if (a === '--target') {
        const raw = readRequiredFlagValue(args, i, '--target');
        i++;
        targetArgs.push(path.resolve(raw));
      } else {
        throw new Error('Unknown option: ' + a);
      }
    }

    if (restore && dryRun) {
      throw new Error('--restore cannot be combined with --check/--dry-run');
    }
    if (restore && contextLimit !== null) {
      throw new Error('--context-limit cannot be combined with --restore');
    }

    const targets = targetArgs.length > 0 ? uniqueTargets(targetArgs) : discoverDefaultTargets();
    if (targets.length === 0) {
      const msg = 'No backend binary targets found (language_server / agy)';
      if (jsonOut) {
        console.log(JSON.stringify({ error: msg }, null, 2));
      } else {
        console.error(`[backend-patcher] ${msg}`);
      }
      process.exit(2);
    }

    if (dryRun) {
      const reports = targets.map((t) => {
        try {
          const info = analyzeBinary(t, { backupDir, contextLimit });
          info.compatible = info.status === 'UNPATCHED' || info.status === 'ALREADY_PATCHED';
          return info;
        } catch (err) {
          return { path: t, status: 'UNSUPPORTED_OR_UNRECOGNIZED', compatible: false, error: err.message };
        }
      });
      if (jsonOut) {
        console.log(JSON.stringify(reports, null, 2));
      } else {
        for (const r of reports) {
          if (r.error) {
            console.log(`[ERR] ${r.path}: ${r.status} (${r.error})`);
          } else {
            const host = r.functions.trampolineHost.symbol.split('.').pop();
            console.log(`[OK] ${r.path}: ${r.status} | ${r.format} ${r.arch} | host=${host} | limit=${r.context_limit} | sites=${r.changes.length}`);
          }
        }
      }
      process.exit(reports.every((r) => r.compatible) ? 0 : 2);
    }

    if (kill) killRunningBackends(targets);

    const results = [];
    for (const t of targets) {
      if (restore) {
        const r = restoreTarget(t, { backupDir });
        results.push(r);
        if (!jsonOut) console.log(`[restored] ${r.path} -> ${r.restored_sha256.slice(0, 16)}..`);
      } else {
        const r = patchTarget(t, { backupDir, contextLimit: contextLimit || DEFAULT_CONTEXT_LIMIT });
        results.push(r);
        if (!jsonOut) console.log(`[${r.status.toLowerCase()}] ${r.path} (limit=${r.context_limit}, sha256=${(r.patched_sha256 || r.sha256).slice(0, 16)}..)`);
      }
    }
    if (!restore) {
      pruneOldBackups(backupDir, targets);
    }
    if (jsonOut) {
      console.log(JSON.stringify(results, null, 2));
    }
  } catch (err) {
    if (jsonOut) {
      console.log(JSON.stringify({ error: err.message }, null, 2));
    } else {
      console.error(`[ERR] ${err.message}`);
    }
    process.exit(1);
  }
}

module.exports = {
  TARGET_FUNCS,
  HOST_SYMBOL_MARKER,
  HOST_FALLBACK_SYMBOLS,
  HOST_PREFERENCE,
  HOST_SPAN,
  HOST_NOOP_ENTRY,
  DATA_SEGMENT_SKIP,
  DEFAULT_256K_TOKEN_LIMIT,
  DEFAULT_CONTEXT_LIMIT,
  HIGH_CONTEXT_LIMIT,
  MAX_CONTEXT_LIMIT,
  ACCEPTED_LIMITS,
  DEFAULT_BACKUP_DIR,
  BinaryImage,
  locateGoFunctions,
  describeFunction,
  orderHostCandidates,
  collectTextReferences,
  storedAddressPresent,
  validCheckpointEntry,
  entryHasNopFill,
  chooseTrampolineHost,
  buildX86_64Plan,
  buildArm64Plan,
  analyzeBinary,
  parseContextLimit,
  discoverDefaultTargets,
  getBinaryVersion,
  patchTarget,
  restoreTarget,
  replaceAtomicOrOverwrite,
  ensureBackendNotRunning,
  selectRestoreBackup,
  pruneOldBackups,
  runningBackends,
  killRunningBackends,
  updateAgySidecarIfPresent
};
