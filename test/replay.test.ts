import { describe, expect, test } from "bun:test";
import {
  deriveKey,
  encrypt,
  decrypt,
  encodeHeader,
  decodeHeader,
  acceptFrame,
  initialRekeyState,
  initialSenderPin,
  updateSenderPin,
  shouldRotate,
  isValidSeq,
  HEADER_BYTES,
  MAX_FRAME_BYTES,
  MAX_PAYLOAD_BYTES,
  MAX_PENDING_QUEUE,
  REKEY_AFTER_PACKETS,
  REKEY_AFTER_MS,
} from "../src/shared";

const SECRET = "test-shared-key";

describe("epoch frame roundtrip", () => {
  test("encrypt/decrypt epoch 0", () => {
    const key = deriveKey(SECRET, 0);
    const frame = encrypt(Buffer.from("hello"), key, 0, 0);
    const header = decodeHeader(frame);
    expect(header).toEqual({ epoch: 0, seq: 0 });
    expect(decrypt(frame, key)?.toString()).toBe("hello");
  });

  test("epoch keys differ; wrong-epoch key fails", () => {
    const k0 = deriveKey(SECRET, 0);
    const k1 = deriveKey(SECRET, 1);
    expect(k0.equals(k1)).toBe(false);
    const frame = encrypt(Buffer.from("data"), k0, 0, 7);
    expect(decrypt(frame, k1)).toBeNull();
  });

  test("header tamper fails auth", () => {
    const key = deriveKey(SECRET, 0);
    const frame = encrypt(Buffer.from("x".repeat(32)), key, 0, 3);
    frame[7] ^= 0xff; // flip seq bit inside AAD
    expect(decrypt(frame, key)).toBeNull();
  });

  test("ciphertext tamper fails auth", () => {
    const key = deriveKey(SECRET, 0);
    const frame = encrypt(Buffer.from("tamper-me"), key, 2, 9);
    frame[HEADER_BYTES + 12] ^= 0x01;
    expect(decrypt(frame, key)).toBeNull();
  });

  test("short and oversize frames rejected", () => {
    const key = deriveKey(SECRET, 0);
    expect(decrypt(Buffer.alloc(4), key)).toBeNull();
    expect(decrypt(Buffer.alloc(MAX_FRAME_BYTES + 1), key)).toBeNull();
  });
});

describe("replay window (acceptFrame)", () => {
  test("monotonic ok, replay/duplicate dropped", () => {
    let st = initialRekeyState();
    let r = acceptFrame(st, 0, 0);
    expect(r.ok).toBe(true);
    st = r.state;
    r = acceptFrame(st, 0, 1);
    expect(r.ok).toBe(true);
    st = r.state;
    expect(acceptFrame(st, 0, 1).ok).toBe(false); // duplicate
    expect(acceptFrame(st, 0, 0).ok).toBe(false); // replay
  });

  test("implausible jump rejected", () => {
    const st = { epoch: 0, lastSeq: 5 };
    expect(acceptFrame(st, 0, 5 + 1_000_001).ok).toBe(false);
    expect(acceptFrame(st, 0, 6).ok).toBe(true);
  });

  test("epoch rotation promotes on epoch+1 seq 0", () => {
    let st = { epoch: 0, lastSeq: 42 };
    const r = acceptFrame(st, 1, 0);
    expect(r.ok).toBe(true);
    expect(r.state).toEqual({ epoch: 1, lastSeq: 0 });
    st = r.state;
    // old epoch now dropped
    expect(acceptFrame(st, 0, 43).ok).toBe(false);
    // skip-ahead epoch rejected
    expect(acceptFrame(st, 3, 0).ok).toBe(false);
    // normal flow continues on new epoch
    expect(acceptFrame(st, 1, 1).ok).toBe(true);
  });

  test("rotation rejects fresh epoch with large seq", () => {
    const st = { epoch: 0, lastSeq: 1 };
    expect(acceptFrame(st, 1, 5000).ok).toBe(false);
  });
});

describe("rotation schedule", () => {
  test("packet count triggers", () => {
    expect(shouldRotate(REKEY_AFTER_PACKETS, 0)).toBe(true);
    expect(shouldRotate(REKEY_AFTER_PACKETS - 1, 0)).toBe(false);
  });
  test("wall clock triggers", () => {
    expect(shouldRotate(0, REKEY_AFTER_MS)).toBe(true);
    expect(shouldRotate(10, 1000)).toBe(false);
  });
  test("isValidSeq monotonic", () => {
    expect(isValidSeq(-1, 0)).toBe(true);
    expect(isValidSeq(0, 0)).toBe(false);
    expect(isValidSeq(3, 2)).toBe(false);
  });
});

describe("oversize guards", () => {
  test("WS frame over MAX_FRAME_BYTES rejected", () => {
    const key = deriveKey(SECRET, 0);
    expect(decrypt(Buffer.alloc(MAX_FRAME_BYTES + 1), key)).toBeNull();
  });
  test("UDP payload cap sane (65507)", () => {
    expect(MAX_PAYLOAD_BYTES).toBe(65507);
    expect(MAX_PENDING_QUEUE).toBe(100);
    // A max-size UDP payload still fits inside a max WS frame
    const key = deriveKey(SECRET, 0);
    const frame = encrypt(Buffer.alloc(MAX_PAYLOAD_BYTES), key, 0, 0);
    expect(frame.length).toBeLessThanOrEqual(MAX_FRAME_BYTES);
  });
});

describe("sender pinning (updateSenderPin)", () => {
  const TTL = 60_000;
  test("first sender wins; spoofed source ignored", () => {
    let pin = initialSenderPin();
    let r = updateSenderPin(pin, false, "1.1.1.1:100", 1000, TTL);
    pin = r.state;
    expect(r.accepted).toBe(true);
    // Spoofed second source with pinned entry present: ignored
    r = updateSenderPin(pin, true, "9.9.9.9:200", 2000, TTL);
    expect(r.accepted).toBe(false);
    expect(r.state.pinned).toBe("1.1.1.1:100");
    // Legit repeat from pinned sender accepted
    r = updateSenderPin(pin, true, "1.1.1.1:100", 3000, TTL);
    expect(r.accepted).toBe(true);
  });
  test("re-pins after TTL so peer change recovers", () => {
    let pin = initialSenderPin();
    pin = updateSenderPin(pin, false, "1.1.1.1:100", 0, TTL).state;
    const r = updateSenderPin(pin, true, "2.2.2.2:300", TTL + 1, TTL);
    expect(r.accepted).toBe(true);
    expect(r.state.pinned).toBe("2.2.2.2:300");
  });
  test("re-pins when pinned entry evicted", () => {
    let pin = initialSenderPin();
    pin = updateSenderPin(pin, false, "1.1.1.1:100", 1000, TTL).state;
    const r = updateSenderPin(pin, false, "3.3.3.3:400", 2000, TTL);
    expect(r.accepted).toBe(true);
    expect(r.state.pinned).toBe("3.3.3.3:400");
  });
});
describe("no-auth framing", () => {
  test("header + plaintext parses and replays drop", () => {
    const wire = Buffer.concat([encodeHeader(0, 4), Buffer.from("plain")]);
    const h = decodeHeader(wire);
    expect(h).toEqual({ epoch: 0, seq: 4 });
    let st = initialRekeyState();
    // advance to seq 4 step by step
    for (let s = 0; s <= 4; s++) st = acceptFrame(st, 0, s).state;
    expect(acceptFrame(st, 0, 4).ok).toBe(false);
    expect(wire.subarray(HEADER_BYTES).toString()).toBe("plain");
  });
});
