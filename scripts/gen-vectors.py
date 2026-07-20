#!/usr/bin/env python3
"""Generate the checked-in known-answer vectors for gate G0 (PORT_PLAN M0).

Independence requirement: the TypeScript code under test hashes via ethers
(@noble/hashes keccak) and ABI-encodes via ethers' AbiCoder. This generator
must share none of that code, so it uses pycryptodome's keccak and hand-rolls
Solidity packed encoding, ABI encoding, LibPack.packArrU32, and
@mud-classic/utils packTuple (JS signed-32-bit semantics) from their
specifications:

  - LibConfig.genID(name)  = keccak256(abi.encodePacked("is.config", name))
      packages/contracts/src/libraries/LibConfig.sol @ the UPSTREAM pin
  - LibPack.packArrU32     = fold left: result = (result << 32) | values[i]
      (values[i] must be < 2**32 - 1 on-chain)
      packages/contracts/src/libraries/utils/LibPack.sol @ the UPSTREAM pin
  - packTuple([a, b])      = JS ((a << 24) | b) — a signed 32-bit result
      @mud-classic/utils@0.0.3 src/pack.ts
  - formatEntityID(id)     = '0x' + BigInt(id).toString(16)  (unpadded)
      packages/client/src/engine/utils.ts @ the UPSTREAM pin

Run:  python3 scripts/gen-vectors.py   (needs: pip install pycryptodome)
Writes test/vectors/*.json. Vectors are generated once per UPSTREAM pin and
checked in; regeneration is only expected on a pin advance.
"""

import json
from pathlib import Path

from Crypto.Hash import keccak as _keccak

OUT = Path(__file__).resolve().parent.parent / "test" / "vectors"

META = {
    "generator": "scripts/gen-vectors.py (pycryptodome keccak — independent of ethers/@noble)",
    "upstream-pin": "ef898fc9350a6085fb080419b12af96c2254e8f3",
}


def keccak256(data: bytes) -> bytes:
    return _keccak.new(digest_bits=256, data=data).digest()


def solidity_packed(arg_types, args) -> bytes:
    """abi.encodePacked for the types kami-lens hashArgs call sites use."""
    out = b""
    for typ, arg in zip(arg_types, args, strict=True):
        if typ == "string":
            out += str(arg).encode("utf-8")
        elif typ == "uint32":
            out += int(arg).to_bytes(4, "big")
        elif typ == "uint256":
            out += int(arg).to_bytes(32, "big")
        else:
            raise ValueError(f"unsupported packed type {typ}")
    return out


def format_entity_id(n: int) -> str:
    """Upstream formatEntityID: '0x' + BigInt.toString(16) — no zero padding."""
    return "0x" + format(n, "x")


def word(n: int) -> bytes:
    return n.to_bytes(32, "big", signed=False)


def abi_encode_single(value_type: str, value) -> bytes:
    """ABI encoding of a single value — static word, or offset+length+data."""
    if value_type.endswith("[]"):
        elems = b"".join(word(int(v)) for v in value)
        return word(0x20) + word(len(value)) + elems
    if value_type == "bool":
        return word(1 if value else 0)
    if value_type == "string":
        data = str(value).encode("utf-8")
        padded = data + b"\x00" * (-len(data) % 32)
        return word(0x20) + word(len(data)) + padded
    if value_type.startswith("int"):
        return int(value).to_bytes(32, "big", signed=True)
    if value_type.startswith("uint"):
        return word(int(value))
    raise ValueError(f"unsupported abi type {value_type}")


def to_signed32(n: int) -> int:
    n &= 0xFFFFFFFF
    return n - 0x100000000 if n >= 0x80000000 else n


def write(name: str, vectors) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / name
    path.write_text(json.dumps({"_meta": META, "vectors": vectors}, indent=2) + "\n")
    print(f"wrote {path.relative_to(OUT.parent.parent)} ({len(vectors)} vectors)")


# --- config-ids: hashArgs(['is.config', field]) must equal LibConfig.genID ---

CONFIG_FIELDS = [
    # real fields read by the pinned client's config readers / calc layer
    "BASE_FRIENDS_LIMIT",
    "FRIENDS_REQUEST_LIMIT",
    "KAMI_HARV_BOUNTY",
    "KAMI_HARV_EFFICACY_BODY",
    "KAMI_HARV_FERTILITY",
    "KAMI_HARV_INTENSITY",
    "KAMI_HARV_STRAIN",
    "KAMI_LIQ_THRESHOLD",
    "KAMI_LVL_REQ_BASE",
    "KAMI_REST_METABOLISM",
    "KAMI_STANDARD_COOLDOWN",
    "MINT_MAX_TOTAL",
    "NEWBIE_VENDOR_CYCLE",
    "PORTAL_ITEM_EXPORT_TAX",
]


def leading_zero_field() -> str:
    """Synthetic field whose config-ID hash starts with a zero nibble, so the
    vectors exercise formatEntityID's unpadding (id shorter than the hash)."""
    i = 0
    while True:
        name = f"KAMI_LENS_SYNTHETIC_LZ_{i}"
        if keccak256(solidity_packed(["string", "string"], ["is.config", name]))[0] < 0x10:
            return name
        i += 1


def gen_config_ids():
    vectors = []
    for field in CONFIG_FIELDS + [leading_zero_field()]:
        digest = keccak256(solidity_packed(["string", "string"], ["is.config", field]))
        vectors.append(
            {
                "field": field,
                "hash": "0x" + digest.hex(),
                "id": format_entity_id(int.from_bytes(digest, "big")),
            }
        )
    write("config-ids.json", vectors)


# --- hash-args: the generic hashArgs signatures observed at the pin ---

HASH_ARGS_CASES = [
    (["string"], ["kami.gacha.commit"]),
    (["string", "uint32"], ["kami.index", 1]),
    (["string", "uint32"], ["room.index", 42]),
    (["string", "uint256"], ["skill.points", "115792089237316195423570985008687907853269984665640564039457584007913129639935"]),
    (["string", "string", "uint256"], ["data", "score", "1000000"]),
]


def gen_hash_args():
    vectors = []
    for arg_types, args in HASH_ARGS_CASES:
        digest = keccak256(solidity_packed(arg_types, args))
        vectors.append(
            {
                "argTypes": arg_types,
                "args": args,
                "id": format_entity_id(int.from_bytes(digest, "big")),
            }
        )
    write("hash-args.json", vectors)


# --- pack-arr-u32: unpackArray32 must invert LibPack.packArrU32 ---


def pack_arr_u32(values) -> int:
    assert len(values) == 8
    result = 0
    for v in values:
        assert 0 <= v < (1 << 32) - 1, "on-chain require: values[i] < 2**32 - 1"
        result = (result << 32) | v
    return result


PACK_ARR_CASES = [
    ([0, 0, 0, 0, 0, 0, 0, 0], None),
    ([1, 2, 3, 4, 5, 6, 7, 8], None),
    ([50, 10, 300, 60, 0, 0, 0, 0], None),
    ([0xFFFFFFFE] * 8, "max value packArrU32 accepts (its require is < 2**32 - 1)"),
    ([0xFFFFFFFE, 0, 0, 0, 0, 0, 0, 0], None),
    ([0, 0, 0, 0, 0, 0, 0, 0xFFFFFFFE], None),
]


def gen_pack_arr():
    vectors = []
    for values, note in PACK_ARR_CASES:
        v = {"values": values, "packed": "0x" + format(pack_arr_u32(values), "064x")}
        if note:
            v["note"] = note
        vectors.append(v)
    # client-only: a word holding full 0xFFFFFFFF lanes can't come from
    # packArrU32 (its require rejects 2**32 - 1) but unpackArray32 must still
    # decode it — packed uint256s can reach the client from other writers.
    full = 0
    for _ in range(8):
        full = (full << 32) | 0xFFFFFFFF
    vectors.append(
        {
            "values": [0xFFFFFFFF] * 8,
            "packed": "0x" + format(full, "064x"),
            "note": "client-only: packArrU32 rejects 2**32 - 1; unpack must still handle it",
        }
    )
    write("pack-arr-u32.json", vectors)


# --- pack-tuple: @mud-classic/utils packTuple([componentIdx, entityIdx]) ---

PACK_TUPLE_CASES = [
    [0, 0],
    [1, 1],
    [94, 12345],          # realistic: 95 components at the pin
    [127, 16777215],      # largest positive-packed pair
    [128, 0],             # JS << is signed 32-bit: packs negative
    [255, 16777215],      # full mask: packs to -1
]


def gen_pack_tuple():
    vectors = []
    for c, e in PACK_TUPLE_CASES:
        vectors.append({"tuple": [c, e], "packed": to_signed32((c << 24) | e)})
    write("pack-tuple.json", vectors)


# --- decode: createDecoder over every schema value type present at the pin ---
# ComponentsSchema at the pin uses exactly these ContractSchemaValue codes:
# 0 BOOL, 3 INT32, 10 UINT32, 13 UINT256, 15 STRING, 28 UINT32_ARRAY,
# 31 UINT256_ARRAY. Expected values follow flattenValue: small ints → number,
# 256-bit ints → unpadded hex string, strings verbatim, arrays elementwise.

DECODE_CASES = [
    ("BOOL", 0, "bool", True, True),
    ("INT32", 3, "int32", -7, -7),
    ("UINT32", 10, "uint32", 1234567, 1234567),
    (
        "UINT256",
        13,
        "uint256",
        12345678901234567890123456789,
        format_entity_id(12345678901234567890123456789),
    ),
    ("STRING", 15, "string", "hello kami", "hello kami"),
    ("UINT32_ARRAY", 28, "uint32[]", [1, 42, 4294967295], [1, 42, 4294967295]),
    (
        "UINT256_ARRAY",
        31,
        "uint256[]",
        [1, 1 << 255],
        [format_entity_id(1), format_entity_id(1 << 255)],
    ),
]


def gen_decode():
    vectors = []
    for name, code, abi_type, value, expected in DECODE_CASES:
        vectors.append(
            {
                "name": name,
                "valueTypes": [code],
                "data": "0x" + abi_encode_single(abi_type, value).hex(),
                "expected": {"value": expected},
            }
        )
    write("decode.json", vectors)


if __name__ == "__main__":
    gen_config_ids()
    gen_hash_args()
    gen_pack_arr()
    gen_pack_tuple()
    gen_decode()
