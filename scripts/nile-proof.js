#!/usr/bin/env node
/**
 * Nile Proof Gate
 *
 * Full V1 swap lifecycle test on the deployed EtomicSwapTron contract:
 *   ETH/TRX: ethPayment → hash verify → senderRefund / receiverSpend
 *   TRC20:   erc20Payment (USDT, BTT) → hash verify → senderRefund / receiverSpend
 *
 */

require("dotenv").config();
const crypto = require("crypto");
const { TronWeb } = require("tronweb");

const TRON_PRIVATE_KEY = process.env.TRON_PRIVATE_KEY;
const FULL_HOST = process.env.TRON_NILE_FULLHOST || "https://nile.trongrid.io";

// --------------- Deployed contract (Nile) ---------------
const CONTRACT_HEX = "41bfec12aa6f266fc0010df10b9e5a9d49149a5c4e";
// TRON TVM strips the 41 prefix during abi.encodePacked — addresses are 20 bytes like EVM.
const ZERO_ADDR_ABI = "0000000000000000000000000000000000000000"; // 20 bytes (for hash computation)
const TRON_ZERO_ADDR = "410000000000000000000000000000000000000000";  // 21 bytes (for contract args)

// --------------- TRC20 tokens (Nile testnet) ---------------
const TOKENS = {
  BTT:  { base58: "TNuoKL1ni8aoshfFL1ASca1Gou9RXwAzfn", decimals: 18, symbol: "BTT" },
  USDT: { base58: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf", decimals: 6,  symbol: "USDT" },
};

// --------------- ABI snippets ---------------
const ABI = [
  {
    inputs: [{ internalType: "bytes32", name: "id", type: "bytes32" }],
    name: "payments",
    outputs: [
      { internalType: "bytes32", name: "paymentHash", type: "bytes32" },
      { internalType: "uint64", name: "lockTime", type: "uint64" },
      { internalType: "uint8", name: "state", type: "uint8" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "id", type: "bytes32" },
      { internalType: "address", name: "receiver", type: "address" },
      { internalType: "bytes32", name: "secretHash", type: "bytes32" },
      { internalType: "uint64", name: "lockTime", type: "uint64" },
    ],
    name: "ethPayment",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "id", type: "bytes32" },
      { internalType: "uint256", name: "amount", type: "uint256" },
      { internalType: "address", name: "tokenAddress", type: "address" },
      { internalType: "address", name: "receiver", type: "address" },
      { internalType: "bytes32", name: "secretHash", type: "bytes32" },
      { internalType: "uint64", name: "lockTime", type: "uint64" },
    ],
    name: "erc20Payment",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "id", type: "bytes32" },
      { internalType: "uint256", name: "amount", type: "uint256" },
      { internalType: "bytes32", name: "secretHash", type: "bytes32" },
      { internalType: "address", name: "tokenAddress", type: "address" },
      { internalType: "address", name: "receiver", type: "address" },
    ],
    name: "senderRefund",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "id", type: "bytes32" },
      { internalType: "uint256", name: "amount", type: "uint256" },
      { internalType: "bytes32", name: "secret", type: "bytes32" },
      { internalType: "address", name: "tokenAddress", type: "address" },
      { internalType: "address", name: "sender", type: "address" },
    ],
    name: "receiverSpend",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
];

// --------------- ERC20 ABI (approve, balanceOf) ---------------
const ERC20_ABI = [
  {
    inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }],
    name: "approve", outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable", type: "function",
  },
  {
    inputs: [{ name: "owner", type: "address" }],
    name: "balanceOf", outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view", type: "function",
  },
];

// --------------- Helpers ---------------

/** Compute paymentHash exactly as the Solidity contract does on TRON TVM.
 *
 *  CRITICAL: TRON TVM strips the 0x41 prefix during abi.encodePacked,
 *  so addresses are 20 bytes (like EVM), NOT 21 bytes.
 *
 *  @param {string|null} tokenHex - 21-byte TRON hex token address, or null for ETH (address(0))
 */
function computePaymentHash(receiverHex, senderHex, secretHashHex, amount, tokenHex) {
  const tokenAbi = tokenHex ? Buffer.from(strip41(tokenHex), "hex") : Buffer.from(ZERO_ADDR_ABI, "hex");
  const buf = Buffer.concat([
    Buffer.from(strip41(receiverHex), "hex"),             // 20 bytes
    Buffer.from(strip41(senderHex), "hex"),               // 20 bytes
    Buffer.from(strip0x(secretHashHex), "hex"),           // 32 bytes
    tokenAbi,                                             // 20 bytes (token or zero)
    hexTo32Bytes(amount.toString(16)),                    // 32 bytes (big-endian uint256)
  ]);

  return "0x" + crypto.createHash("sha256").update(buf).digest("hex");
}

/** Strip leading 41 byte from TRON hex address, yielding 20-byte EVM-style address. */
function strip41(hex) {
  const h = hex.replace(/^0x/, "");
  return h.startsWith("41") ? h.slice(2) : h;
}

/** Pad hex to 32 bytes (64 hex chars) big-endian. Strips 0x prefix. */
function hexTo32Bytes(hex) {
  const stripped = hex.replace(/^0x/, "");
  return Buffer.from(stripped.padStart(64, "0"), "hex");
}

/** Strip 0x prefix from a hex string. */
function strip0x(h) {
  return h.replace(/^0x/, "");
}

/** Convert a hex address (with or without 0x/41 prefix) to TRON hex format (41...). */
function toTronHex(addr) {
  let h = addr.replace(/^0x/, "");
  if (!h.startsWith("41")) h = "41" + h;
  return h;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const STATE_NAMES = ["Uninitialized", "PaymentSent", "ReceiverSpent", "SenderRefunded"];

/** Poll payments(id) until state matches expected, or timeout. */
async function waitForState(contract, id, expectedState, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const p = await contract.payments(id).call();
    if (Number(p.state) === expectedState) return;
    await sleep(3000);
  }
  const p = await contract.payments(id).call();
  console.error(`   ❌ [${label}] Timed out waiting for state ${STATE_NAMES[expectedState]}, got ${STATE_NAMES[Number(p.state)]}`);
  process.exit(1);
}

// --------------- Main ---------------

async function main() {
  if (!TRON_PRIVATE_KEY) {
    console.error("❌ TRON_PRIVATE_KEY not set in environment.");
    process.exit(1);
  }

  const tronWeb = new TronWeb({
    fullHost: FULL_HOST,
    privateKey: TRON_PRIVATE_KEY,
  });

  const senderBase58 = tronWeb.defaultAddress.base58;
  const senderHex = toTronHex(tronWeb.defaultAddress.hex);
  console.log(`🔑 Sender: ${senderBase58}  (hex: ${senderHex})\n`);

  const contract = await tronWeb.contract(ABI, CONTRACT_HEX);
  const amountSun = 1000000; // 1 TRX

  // ═══════════════════════════════════════════════════════════════
  // SETUP: Generate secrets for spend and refund tests
  // ═══════════════════════════════════════════════════════════════

  // --- Spend test: normal locktime ---
  const spendId = "0x" + crypto.randomBytes(32).toString("hex");
  const spendSecret = crypto.randomBytes(32);
  const spendSecretHash = "0x" + crypto.createHash("sha256").update(spendSecret).digest("hex");
  const spendLockTime = Math.floor(Date.now() / 1000) + 3600; // 1 hour

  console.log(`📋 SPEND test vectors:`);
  console.log(`   paymentId:   ${spendId}`);
  console.log(`   secret:      ${spendSecret.toString("hex")}`);
  console.log(`   secretHash:  ${spendSecretHash}`);
  console.log(`   lockTime:    ${spendLockTime} (in ~1hr)`);

  // --- Refund test: short locktime so we don't wait long ---
  const refundId = "0x" + crypto.randomBytes(32).toString("hex");
  const refundSecret = crypto.randomBytes(32);
  const refundSecretHash = "0x" + crypto.createHash("sha256").update(refundSecret).digest("hex");
  const refundLockTime = Math.floor(Date.now() / 1000) + 45; // 45 seconds from now

  console.log(`\n📋 REFUND test vectors:`);
  console.log(`   paymentId:   ${refundId}`);
  console.log(`   secret:      ${refundSecret.toString("hex")}`);
  console.log(`   secretHash:  ${refundSecretHash}`);
  console.log(`   lockTime:    ${refundLockTime} (in ~45s)`);

  // ═══════════════════════════════════════════════════════════════
  // TEST 1: Read uninitialized payments
  // ═══════════════════════════════════════════════════════════════
  console.log(`\n━━━ Test 1: payments(id) for uninitialized IDs ━━━`);

  for (const [label, id] of [["spend", spendId], ["refund", refundId]]) {
    const p = await contract.payments(id).call();
    if (Number(p.state) !== 0) {
      console.error(`   ❌ ${label}: Expected state 0, got ${Number(p.state)}`);
      process.exit(1);
    }
    console.log(`   ✅ ${label}: state=${STATE_NAMES[Number(p.state)]}`);
  }

  // ═══════════════════════════════════════════════════════════════
  // TEST 2: Send both ethPayments
  // ═══════════════════════════════════════════════════════════════
  console.log(`\n━━━ Test 2: Send ethPayments ━━━`);

  // 2a: Spend payment (normal locktime)
  console.log(`   Sending SPEND payment...`);
  try {
    const tx = await contract
      .ethPayment(spendId, senderHex, spendSecretHash, spendLockTime)
      .send({ callValue: amountSun, feeLimit: 150_000_000 });
    console.log(`   ✅ SPEND payment sent. txHash: ${tx}`);
  } catch (err) {
    console.error(`   ❌ SPEND payment failed:`, err.message || err);
    process.exit(1);
  }

  // 2b: Refund payment (short locktime)
  console.log(`   Sending REFUND payment...`);
  try {
    const tx = await contract
      .ethPayment(refundId, senderHex, refundSecretHash, refundLockTime)
      .send({ callValue: amountSun, feeLimit: 150_000_000 });
    console.log(`   ✅ REFUND payment sent. txHash: ${tx}`);
  } catch (err) {
    console.error(`   ❌ REFUND payment failed:`, err.message || err);
    process.exit(1);
  }

  console.log(`\n⏳ Waiting for confirmations...`);
  await sleep(8000);

  // ═══════════════════════════════════════════════════════════════
  // TEST 3: Verify payment hashes match off-chain computation
  // ═══════════════════════════════════════════════════════════════
  console.log(`\n━━━ Test 3: Verify paymentHash (SHA-256) ━━━`);

  for (const [label, id, secretHash] of [
    ["spend", spendId, spendSecretHash],
    ["refund", refundId, refundSecretHash],
  ]) {
    const p = await contract.payments(id).call();
    if (Number(p.state) !== 1) {
      console.error(`   ❌ ${label}: Expected state 1 (PaymentSent), got ${Number(p.state)}`);
      process.exit(1);
    }

    const expected = computePaymentHash(senderHex, senderHex, secretHash, amountSun);
    if (p.paymentHash.toLowerCase() !== expected.toLowerCase()) {
      console.error(`   ❌ ${label}: Hash mismatch!`);
      console.error(`      Stored:   ${p.paymentHash}`);
      console.error(`      Expected: ${expected}`);
      process.exit(1);
    }
    console.log(`   ✅ ${label}: paymentHash matches, state=PaymentSent`);
  }

  // ═══════════════════════════════════════════════════════════════
  // TEST 4: receiverSpend (SPEND payment)
  // ═══════════════════════════════════════════════════════════════
  console.log(`\n━━━ Test 4: receiverSpend (SPEND payment) ━━━`);

  // receiverSpend expects the raw secret (not the hash);
  // the contract internally computes sha256(abi.encodePacked(secret))
  const spendSecretHex = "0x" + spendSecret.toString("hex");

  try {
    const tx = await contract
      .receiverSpend(spendId, amountSun, spendSecretHex, TRON_ZERO_ADDR, senderHex)
      .send({ feeLimit: 150_000_000 });
    console.log(`   ✅ receiverSpend sent. txHash: ${tx}`);
  } catch (err) {
    console.error(`   ❌ receiverSpend failed:`, err.message || err);
    process.exit(1);
  }

  await sleep(5000);

  // Verify spend state
  const spendP = await contract.payments(spendId).call();
  if (Number(spendP.state) !== 2) {
    console.error(`   ❌ Expected state 2 (ReceiverSpent), got ${Number(spendP.state)}`);
    process.exit(1);
  }
  console.log(`   ✅ SPEND confirmed: state=ReceiverSpent`);

  // ═══════════════════════════════════════════════════════════════
  // TEST 5: senderRefund (REFUND payment)
  // ═══════════════════════════════════════════════════════════════
  console.log(`\n━━━ Test 5: senderRefund (REFUND payment) ━━━`);

  // Wait for the refund locktime to pass
  const now = Math.floor(Date.now() / 1000);
  const waitSec = Math.max(0, refundLockTime - now + 5); // lockTime + 5s buffer
  if (waitSec > 0) {
    console.log(`   ⏳ Waiting ${waitSec}s for lockTime to expire...`);
    await sleep(waitSec * 1000);
  }

  try {
    const tx = await contract
      .senderRefund(refundId, amountSun, refundSecretHash, TRON_ZERO_ADDR, senderHex)
      .send({ feeLimit: 150_000_000 });
    console.log(`   ✅ senderRefund sent. txHash: ${tx}`);
  } catch (err) {
    console.error(`   ❌ senderRefund failed:`, err.message || err);
    process.exit(1);
  }

  await sleep(5000);

  // Verify refund state
  const refundP = await contract.payments(refundId).call();
  if (Number(refundP.state) !== 3) {
    console.error(`   ❌ Expected state 3 (SenderRefunded), got ${Number(refundP.state)}`);
    process.exit(1);
  }
  console.log(`   ✅ REFUND confirmed: state=SenderRefunded`);

  // ═══════════════════════════════════════════════════════════════
  // TRC20 TESTS (spend + refund for each token)
  // ═══════════════════════════════════════════════════════════════
  const results = {};

  for (const [name, cfg] of Object.entries(TOKENS)) {
    console.log(`\n${"━".repeat(30)} TRC20 ${name} ${"━".repeat(30)}`);

    const tokenHex = tronWeb.address.toHex(cfg.base58);
    const tokenContract = await tronWeb.contract(ERC20_ABI, cfg.base58);

    // Check balance — need 2x amount (one for spend, one for refund)
    let balance;
    try {
      balance = Number(await tokenContract.balanceOf(senderBase58).call());
    } catch (e) {
      console.error(`   ❌ Failed to read ${name} balance:`, e.message || e);
      process.exit(1);
    }
    const unitAmount = name === "USDT" ? BigInt(10000) : BigInt("1000000000000000"); // 0.01 USDT or 0.001 BTT
    const need = unitAmount * BigInt(2);
    console.log(`   Balance: ${balance} (${cfg.symbol}), need: ${need} (2 × ${unitAmount})`);
    if (BigInt(balance) < need) {
      console.error(`   ❌ Insufficient ${name} balance! Have ${balance}, need ${need}.`);
      process.exit(1);
    }

    // Approve both amounts at once
    console.log(`   Approving swap contract (zero-first, then 2 × ${unitAmount})...`);
    try {
      await tokenContract.approve(CONTRACT_HEX, 0).send({ feeLimit: 40_000_000 });
      await sleep(3000);
      await tokenContract.approve(CONTRACT_HEX, need).send({ feeLimit: 40_000_000 });
      await sleep(3000);
      console.log(`   ✅ Approved.`);
    } catch (err) {
      console.error(`   ❌ approve failed:`, err.message || err);
      process.exit(1);
    }

    // ---- SPEND payment (normal locktime) ----
    const spendId = "0x" + crypto.randomBytes(32).toString("hex");
    const spendSecret = crypto.randomBytes(32);
    const spendSecretHash = "0x" + crypto.createHash("sha256").update(spendSecret).digest("hex");
    const spendLockTime = Math.floor(Date.now() / 1000) + 3600;

    console.log(`   [SPEND]  Sending erc20Payment...`);
    try {
      const txHash = await contract
        .erc20Payment(spendId, unitAmount, cfg.base58, senderBase58, spendSecretHash, spendLockTime)
        .send({ feeLimit: 150_000_000 });
      console.log(`   ✅ [SPEND]  erc20Payment sent. txHash: ${txHash}`);
    } catch (err) {
      console.error(`   ❌ [SPEND]  erc20Payment failed:`, err.message || err);
      process.exit(1);
    }

    // ---- REFUND payment (short locktime) ----
    const refundId = "0x" + crypto.randomBytes(32).toString("hex");
    const refundSecret = crypto.randomBytes(32);
    const refundSecretHash = "0x" + crypto.createHash("sha256").update(refundSecret).digest("hex");
    const refundLockTime = Math.floor(Date.now() / 1000) + 50;

    console.log(`   [REFUND] Sending erc20Payment...`);
    try {
      const txHash = await contract
        .erc20Payment(refundId, unitAmount, cfg.base58, senderBase58, refundSecretHash, refundLockTime)
        .send({ feeLimit: 150_000_000 });
      console.log(`   ✅ [REFUND] erc20Payment sent. txHash: ${txHash}`);
    } catch (err) {
      console.error(`   ❌ [REFUND] erc20Payment failed:`, err.message || err);
      process.exit(1);
    }

    await sleep(5000);

    // Wait for both payments to confirm
    console.log(`   ⏳ Waiting for payments to confirm...`);
    await waitForState(contract, spendId, 1, 120000, `${name} SPEND`);
    await waitForState(contract, refundId, 1, 120000, `${name} REFUND`);

    // Verify both paymentHashes
    for (const [label, id, secretHash] of [
      ["SPEND", spendId, spendSecretHash],
      ["REFUND", refundId, refundSecretHash],
    ]) {
      const p = await contract.payments(id).call();
      if (Number(p.state) !== 1) {
        console.error(`   ❌ [${label}] Expected state 1 (PaymentSent), got ${Number(p.state)}`);
        process.exit(1);
      }
      const expected = computePaymentHash(senderHex, senderHex, secretHash, unitAmount, tokenHex);
      if (p.paymentHash.toLowerCase() !== expected.toLowerCase()) {
        console.error(`   ❌ [${label}] Hash mismatch! Stored: ${p.paymentHash}, Expected: ${expected}`);
        process.exit(1);
      }
      console.log(`   ✅ [${label}] paymentHash matches, state=PaymentSent`);
    }

    // ---- receiverSpend (no locktime wait needed) ----
    const spendSecretHex = "0x" + spendSecret.toString("hex");
    try {
      const txHash = await contract
        .receiverSpend(spendId, unitAmount, spendSecretHex, cfg.base58, senderHex)
        .send({ feeLimit: 150_000_000 });
      console.log(`   ✅ [SPEND]  receiverSpend sent. txHash: ${txHash}`);
    } catch (err) {
      console.error(`   ❌ [SPEND]  receiverSpend failed:`, err.message || err);
      process.exit(1);
    }
    await waitForState(contract, spendId, 2, 120000, `${name} SPEND`);
    console.log(`   ✅ [SPEND]  ReceiverSpent confirmed`);
    results[`${name} spend`] = true;

    // ---- senderRefund (wait for lockTime then refund) ----
    const now = Math.floor(Date.now() / 1000);
    const waitSec = Math.max(0, refundLockTime - now + 5);
    if (waitSec > 0) {
      console.log(`   ⏳ Waiting ${waitSec}s for refund lockTime to expire...`);
      await sleep(waitSec * 1000);
    }
    try {
      const txHash = await contract
        .senderRefund(refundId, unitAmount, refundSecretHash, cfg.base58, senderBase58)
        .send({ feeLimit: 150_000_000 });
      console.log(`   ✅ [REFUND] senderRefund sent. txHash: ${txHash}`);
    } catch (err) {
      console.error(`   ❌ [REFUND] senderRefund failed:`, err.message || err);
      process.exit(1);
    }
    await waitForState(contract, refundId, 3, 120000, `${name} REFUND`);
    console.log(`   ✅ [REFUND] SenderRefunded confirmed`);
    results[`${name} refund`] = true;
    results[`${name} spend`] = true;
  }

  // ═══════════════════════════════════════════════════════════════
  // DONE
  // ═══════════════════════════════════════════════════════════════
  console.log(`\n${"=".repeat(60)}`);
  console.log(`✅✅✅ NILE PROOF GATE PASSED — ALL PATHS ✅✅✅`);
  console.log(`${"=".repeat(60)}`);
  console.log(`   ETH:   ethPayment    → PaymentSent       ✅`);
  console.log(`   ETH:   SHA-256 hash  → off-chain match   ✅`);
  console.log(`   ETH:   receiverSpend → ReceiverSpent     ✅`);
  console.log(`   ETH:   senderRefund  → SenderRefunded    ✅`);
  console.log(`   BTT:   erc20Payment  → hash verify       ✅`);
  console.log(`   BTT:   receiverSpend → ReceiverSpent     ✅`);
  console.log(`   BTT:   senderRefund  → SenderRefunded    ✅`);
  console.log(`   USDT:  erc20Payment  → hash verify       ✅`);
  console.log(`   USDT:  receiverSpend → ReceiverSpent     ✅`);
  console.log(`   USDT:  senderRefund  → SenderRefunded    ✅`);
  console.log(`\n   Safe to proceed with KDF integration.`);
}

main().catch((err) => {
  console.error(`\n❌ Unexpected error:`, err.message || err);
  process.exit(1);
});
