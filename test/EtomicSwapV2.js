const {
    expect
} = require("chai");
const {
    ethers
} = require("hardhat");
const crypto = require('crypto');
const RIPEMD160 = require('ripemd160');

require('chai')
    .use(require('chai-as-promised'))
    .should();

const INVALID_HASH = 'Invalid paymentHash';
const INVALID_PAYMENT_STATE = 'Invalid payment state. Must be PaymentSent';
const INVALID_TIMESTAMP = 'Current timestamp didn\'t exceed payment lock time';
const UNSUPPORTED_VALUE = 'unsupported addressable value (argument="target", value=null, code=INVALID_ARGUMENT, version=6.10.0)';
const REFUND_TIMESTAMP_NOT_REACHED = 'Current timestamp didn\'t exceed payment refund lock time';

/**
 * Advances the Ethereum Virtual Machine (EVM) time by a specified amount and then mines a new block.
 *
 * @param {number} increaseAmount The amount of time to advance in seconds.
 *
 * This function is used in Ethereum smart contract testing to simulate the passage of time. In the EVM,
 * time is measured based on block timestamps. The 'evm_increaseTime' method increases the EVM's internal
 * clock, but this change only affects the next mined block. Therefore, 'evm_mine' is called immediately
 * afterwards to mine a new block, ensuring that the blockchain's timestamp is updated to reflect the time
 * change. This approach is essential for testing time-dependent contract features like lock periods or deadlines.
 */
async function advanceTimeAndMine(increaseAmount) {
    await ethers.provider.send("evm_increaseTime", [increaseAmount]);
    await ethers.provider.send("evm_mine");
}

async function currentEvmTime() {
    const block = await ethers.provider.getBlock("latest");
    return block.timestamp;
}

const id = '0x' + crypto.randomBytes(32).toString('hex');
const [TAKER_PAYMENT_UNINITIALIZED, TAKER_PAYMENT_SENT, TAKER_PAYMENT_APPROVED, MAKER_SPENT, TAKER_REFUNDED] = [0, 1, 2, 3, 4];
const [MAKER_PAYMENT_UNINITIALIZED, MAKER_PAYMENT_SENT, TAKER_SPENT, MAKER_REFUNDED] = [0, 1, 2, 3];

const takerSecret = crypto.randomBytes(32);
const takerSecretHash = '0x' + new RIPEMD160().update(crypto.createHash('sha256').update(takerSecret).digest()).digest('hex');

const makerSecret = crypto.randomBytes(32);
const makerSecretHash = '0x' + new RIPEMD160().update(crypto.createHash('sha256').update(makerSecret).digest()).digest('hex');

const invalidSecret = crypto.randomBytes(32);

const zeroAddr = '0x0000000000000000000000000000000000000000';
const dexFeeAddr = '0x7777777777777777777777777777777777777777';

describe("EtomicSwapV2", function() {

    beforeEach(async function() {
        accounts = await ethers.getSigners();

        EtomicSwapV2 = await ethers.getContractFactory("EtomicSwapV2");
        etomicSwapV2 = await EtomicSwapV2.deploy(dexFeeAddr);
        etomicSwapV2.waitForDeployment();

        Token = await ethers.getContractFactory("Token");
        token = await Token.deploy();
        token.waitForDeployment();

        await token.transfer(accounts[1].address, ethers.parseEther('100'));
    });

    it('should create contract with uninitialized payments', async function() {
        const taker_payment = await etomicSwapV2.taker_payments(id);
        expect(Number(taker_payment[3])).to.equal(TAKER_PAYMENT_UNINITIALIZED);

        const maker_payment = await etomicSwapV2.maker_payments(id);
        expect(Number(maker_payment[2])).to.equal(MAKER_PAYMENT_UNINITIALIZED);
    });

    it('should allow maker to send ETH payment', async function() {
        let current_time = await currentEvmTime();
        const paymentLockTime = current_time + 100;
        const params = [
            id,
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            paymentLockTime
        ];
        // Make the ETH payment
        await etomicSwapV2.connect(accounts[0]).ethMakerPayment(...params, {
            value: ethers.parseEther('1')
        }).should.be.fulfilled;

        const payment = await etomicSwapV2.maker_payments(id);

        expect(Number(payment[1])).to.equal(paymentLockTime);
        expect(Number(payment[2])).to.equal(MAKER_PAYMENT_SENT);

        // Check that it should not allow to send again
        await etomicSwapV2.connect(accounts[0]).ethMakerPayment(...params, {
            value: ethers.parseEther('1')
        }).should.be.rejectedWith("Maker payment is already initialized");
    });

    it('should allow maker to send ERC20 payment', async function() {
        const current_time = await currentEvmTime();

        const paymentLockTime = current_time + 100;

        const payment_params = [
            id,
            ethers.parseEther('1'),
            token.target,
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            paymentLockTime,
        ];

        let etomicSwapRunner0 = etomicSwapV2.connect(accounts[0]);

        await token.approve(etomicSwapV2.target, ethers.parseEther('1'));
        // Make the ERC20 payment
        await etomicSwapRunner0.erc20MakerPayment(...payment_params).should.be.fulfilled;

        // Check contract token balance
        const balance = await token.balanceOf(etomicSwapV2.target);
        expect(balance).to.equal(ethers.parseEther('1'));

        const payment = await etomicSwapV2.maker_payments(id);

        // Check locktime and status
        expect(payment[1]).to.equal(BigInt(paymentLockTime));
        expect(payment[2]).to.equal(BigInt(MAKER_PAYMENT_SENT));

        // Should not allow to send payment again
        await etomicSwapRunner0.erc20MakerPayment(...payment_params).should.be.rejectedWith("Maker payment is already initialized");
    });

    it('should allow taker to spend ETH maker payment', async function() {
        let current_time = await currentEvmTime();
        const paymentLockTime = current_time + 100;
        const payment_params = [
            id,
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            paymentLockTime
        ];
        // Make the ETH payment
        await etomicSwapV2.connect(accounts[0]).ethMakerPayment(...payment_params, {
            value: ethers.parseEther('1')
        }).should.be.fulfilled;

        const spend_params_invalid_secret = [
            id,
            ethers.parseEther('1'),
            accounts[0].address,
            takerSecretHash,
            invalidSecret,
            zeroAddr,
        ];
        await etomicSwapV2.connect(accounts[1]).spendMakerPayment(...spend_params_invalid_secret).should.be.rejectedWith(INVALID_HASH);

        const spend_params_invalid_amount = [
            id,
            ethers.parseEther('0.9'),
            accounts[0].address,
            takerSecretHash,
            makerSecret,
            zeroAddr,
        ];
        await etomicSwapV2.connect(accounts[1]).spendMakerPayment(...spend_params_invalid_amount).should.be.rejectedWith(INVALID_HASH);

        const spend_params = [
            id,
            ethers.parseEther('1'),
            accounts[0].address,
            takerSecretHash,
            makerSecret,
            zeroAddr,
        ];

        // should not allow to spend from non-taker address
        await etomicSwapV2.connect(accounts[2]).spendMakerPayment(...spend_params).should.be.rejectedWith(INVALID_HASH);

        const balanceBefore = await ethers.provider.getBalance(accounts[1].address);
        const gasPrice = ethers.parseUnits('100', 'gwei');

        const spend_tx = await etomicSwapV2.connect(accounts[1]).spendMakerPayment(...spend_params, {
            gasPrice
        }).should.be.fulfilled;

        const spend_receipt = await spend_tx.wait();
        const gasUsed = ethers.parseUnits(spend_receipt.gasUsed.toString(), 'wei');
        const txFee = gasUsed * gasPrice;

        const balanceAfter = await ethers.provider.getBalance(accounts[1].address);
        // Check sender balance
        expect((balanceAfter - balanceBefore + txFee)).to.equal(ethers.parseEther('1'));

        const payment = await etomicSwapV2.maker_payments(id);

        expect(Number(payment[2])).to.equal(TAKER_SPENT);

        // should not allow to spend again
        await etomicSwapV2.connect(accounts[1]).spendMakerPayment(...spend_params).should.be.rejectedWith(INVALID_PAYMENT_STATE);
    });

    it('should allow taker to spend ERC20 maker payment', async function() {
        let current_time = await currentEvmTime();
        const paymentLockTime = current_time + 100;
        const payment_params = [
            id,
            ethers.parseEther('1'),
            token.target,
            accounts[1].address, // taker
            takerSecretHash,
            makerSecretHash,
            paymentLockTime
        ];

        // Make the ERC20 payment
        await token.approve(etomicSwapV2.target, ethers.parseEther('1'));
        await etomicSwapV2.connect(accounts[0]).erc20MakerPayment(...payment_params).should.be.fulfilled;

        const contractBalance = await token.balanceOf(etomicSwapV2.target);
        expect(contractBalance).to.equal(ethers.parseEther('1'));

        const spend_params_invalid_secret = [
            id,
            ethers.parseEther('1'),
            accounts[0].address,
            takerSecretHash,
            invalidSecret,
            token.target,
        ];
        await etomicSwapV2.connect(accounts[1]).spendMakerPayment(...spend_params_invalid_secret).should.be.rejectedWith(INVALID_HASH);

        const spend_params_invalid_amount = [
            id,
            ethers.parseEther('0.9'),
            accounts[0].address,
            takerSecretHash,
            makerSecret,
            token.target,
        ];
        await etomicSwapV2.connect(accounts[1]).spendMakerPayment(...spend_params_invalid_amount).should.be.rejectedWith(INVALID_HASH);

        const spend_params = [
            id,
            ethers.parseEther('1'),
            accounts[0].address, // maker
            takerSecretHash,
            makerSecret,
            token.target,
        ];

        // should not allow to spend from non-taker address
        await etomicSwapV2.connect(accounts[2]).spendMakerPayment(...spend_params).should.be.rejectedWith(INVALID_HASH);

        const balanceBefore = await token.balanceOf(accounts[1].address);

        const gasPrice = ethers.parseUnits('100', 'gwei');
        await etomicSwapV2.connect(accounts[1]).spendMakerPayment(...spend_params, {
            gasPrice
        }).should.be.fulfilled;

        const balanceAfter = await token.balanceOf(accounts[1].address);
        // Check taker balance
        expect((balanceAfter - balanceBefore)).to.equal(ethers.parseEther('1'));

        const payment = await etomicSwapV2.maker_payments(id);

        expect(Number(payment[2])).to.equal(TAKER_SPENT);

        // should not allow to spend again
        await etomicSwapV2.connect(accounts[1]).spendMakerPayment(...spend_params).should.be.rejectedWith(INVALID_PAYMENT_STATE);
    });

    it('should allow taker to send ETH payment', async function() {
        let current_time = await currentEvmTime();
        const immediateRefundLockTime = current_time + 100;
        const paymentLockTime = current_time + 100;
        const params = [
            id,
            ethers.parseEther('0.1'),
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            immediateRefundLockTime,
            paymentLockTime
        ];
        // Make the ETH payment
        await etomicSwapV2.connect(accounts[0]).ethTakerPayment(...params, {
            value: ethers.parseEther('1')
        }).should.be.fulfilled;

        const payment = await etomicSwapV2.taker_payments(id);

        expect(Number(payment[1])).to.equal(immediateRefundLockTime);
        expect(Number(payment[2])).to.equal(paymentLockTime);
        expect(Number(payment[3])).to.equal(TAKER_PAYMENT_SENT);

        // Check that it should not allow to send again
        await etomicSwapV2.connect(accounts[0]).ethTakerPayment(...params, {
            value: ethers.parseEther('1')
        }).should.be.rejectedWith("Taker payment is already initialized");
    });

    it('should allow taker to send ERC20 payment', async function() {
        const current_time = await currentEvmTime();

        const immediateRefundLockTime = current_time + 10;
        const paymentLockTime = current_time + 100;

        const payment_params = [
            id,
            ethers.parseEther('0.9'),
            ethers.parseEther('0.1'),
            token.target,
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            immediateRefundLockTime,
            paymentLockTime,
        ];

        let etomicSwapRunner0 = etomicSwapV2.connect(accounts[0]);

        await token.approve(etomicSwapV2.target, ethers.parseEther('1'));
        // Make the ERC20 payment
        await etomicSwapRunner0.erc20TakerPayment(...payment_params).should.be.fulfilled;

        // Check contract token balance
        const balance = await token.balanceOf(etomicSwapV2.target);
        expect(balance).to.equal(ethers.parseEther('1'));

        const payment = await etomicSwapV2.taker_payments(id);

        // Check locktime and status
        expect(payment[1]).to.equal(BigInt(immediateRefundLockTime));
        expect(payment[2]).to.equal(BigInt(paymentLockTime));
        expect(payment[3]).to.equal(BigInt(TAKER_PAYMENT_SENT));

        // Should not allow to send payment again
        await etomicSwapRunner0.erc20TakerPayment(...payment_params).should.be.rejectedWith("ERC20 v2 payment is already initialized");
    });

    it('should allow maker to spend ETH taker payment', async function() {
        let current_time = await currentEvmTime();
        const immediateRefundLockTime = current_time + 100;
        const paymentLockTime = current_time + 100;
        const payment_params = [
            id,
            ethers.parseEther('0.1'),
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            immediateRefundLockTime,
            paymentLockTime
        ];
        // Make the ETH payment
        await etomicSwapV2.connect(accounts[0]).ethTakerPayment(...payment_params, {
            value: ethers.parseEther('1')
        }).should.be.fulfilled;

        const spend_params = [
            id,
            ethers.parseEther('0.9'),
            ethers.parseEther('0.1'),
            makerSecret,
            accounts[0].address,
            takerSecretHash,
            zeroAddr,
        ];

        const balanceBefore = await ethers.provider.getBalance(accounts[1].address);
        const gasPrice = ethers.parseUnits('100', 'gwei');

        const spend_tx = await etomicSwapV2.connect(accounts[1]).spendTakerPayment(...spend_params, {
            gasPrice
        }).should.be.fulfilled;

        const spend_receipt = await spend_tx.wait();
        const gasUsed = ethers.parseUnits(spend_receipt.gasUsed.toString(), 'wei');
        const txFee = gasUsed * gasPrice;

        const balanceAfter = await ethers.provider.getBalance(accounts[1].address);
        // Check sender balance
        expect((balanceAfter - balanceBefore + txFee)).to.equal(ethers.parseEther('0.9'));

        const dexFeeAddrBalance = await ethers.provider.getBalance(dexFeeAddr);
        expect(dexFeeAddrBalance).to.equal(ethers.parseEther('0.1'));

        const payment = await etomicSwapV2.taker_payments(id);

        expect(Number(payment[3])).to.equal(MAKER_SPENT);
    });

    it('should allow maker to spend ERC20 taker payment', async function() {
        let current_time = await currentEvmTime();
        const immediateRefundLockTime = current_time + 100;
        const paymentLockTime = current_time + 100;
        const payment_params = [
            id,
            ethers.parseEther('0.9'), // amount
            ethers.parseEther('0.1'), // dexFee
            token.target,
            accounts[1].address, // receiver
            takerSecretHash,
            makerSecretHash,
            immediateRefundLockTime,
            paymentLockTime
        ];

        // Make the ERC20 payment
        await token.approve(etomicSwapV2.target, ethers.parseEther('1'));
        await etomicSwapV2.connect(accounts[0]).erc20TakerPayment(...payment_params).should.be.fulfilled;

        const contractBalance = await token.balanceOf(etomicSwapV2.target);
        expect(contractBalance).to.equal(ethers.parseEther('1'));

        const spend_params = [
            id,
            ethers.parseEther('0.9'), // amount
            ethers.parseEther('0.1'), // dexFee
            makerSecret,
            accounts[0].address, // sender
            takerSecretHash,
            token.target, // tokenAddress
        ];

        const balanceBefore = await token.balanceOf(accounts[1].address);

        const gasPrice = ethers.parseUnits('100', 'gwei');
        await etomicSwapV2.connect(accounts[1]).spendTakerPayment(...spend_params, {
            gasPrice
        }).should.be.fulfilled;

        const balanceAfter = await token.balanceOf(accounts[1].address);
        // Check receiver balance
        expect((balanceAfter - balanceBefore)).to.equal(ethers.parseEther('0.9'));

        const dexFeeAddrBalance = await token.balanceOf(dexFeeAddr);
        expect(dexFeeAddrBalance).to.equal(ethers.parseEther('0.1'));

        const payment = await etomicSwapV2.taker_payments(id);

        expect(Number(payment[3])).to.equal(MAKER_SPENT);
    });

    it('should allow taker to refund ETH payment after locktime', async function() {
        const lockTime = (await ethers.provider.getBlock('latest')).timestamp + 1000;
        const params = [
            id,
            ethers.parseEther('0.1'), // dexFee
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            lockTime,
            lockTime
        ];

        let etomicSwapRunner0 = etomicSwapV2.connect(accounts[0]);
        let etomicSwapRunner1 = etomicSwapV2.connect(accounts[1]);

        // Not allow to refund if payment was not sent
        const refundParams = [
            id,
            ethers.parseEther('0.9'),
            ethers.parseEther('0.1'),
            takerSecretHash,
            makerSecretHash,
            zeroAddr,
            accounts[1].address
        ];

        await etomicSwapRunner0.refundTakerPayment(...refundParams)
            .should.be.rejectedWith(INVALID_PAYMENT_STATE);

        // Make the ETH payment
        await etomicSwapRunner0.ethTakerPayment(...params, {
            value: ethers.parseEther('1')
        }).should.be.fulfilled;

        // Not allow to refund before locktime
        await etomicSwapRunner0.refundTakerPayment(...refundParams).should.be.rejectedWith(REFUND_TIMESTAMP_NOT_REACHED);

        // Simulate time passing to exceed the locktime
        await advanceTimeAndMine(1000);

        // Not allow to call refund from non-sender address
        await etomicSwapRunner1.refundTakerPayment(id, ethers.parseEther('0.9'), ethers.parseEther('0.1'), takerSecretHash, makerSecretHash, zeroAddr, accounts[1].address).should.be.rejectedWith(INVALID_HASH);

        // Not allow to refund invalid amount
        await etomicSwapRunner0.refundTakerPayment(id, ethers.parseEther('2'), ethers.parseEther('0.1'), takerSecretHash, makerSecretHash, zeroAddr, accounts[1].address).should.be.rejectedWith(INVALID_HASH);

        // Success refund
        const balanceBefore = await ethers.provider.getBalance(accounts[0].address);
        const gasPrice = ethers.parseUnits('100', 'gwei');

        const tx = await etomicSwapRunner0.refundTakerPayment(...refundParams, {
            gasPrice
        }).should.be.fulfilled;

        const receipt = await tx.wait();
        const gasUsed = ethers.parseUnits(receipt.gasUsed.toString(), 'wei');
        const txFee = gasUsed * gasPrice;

        const balanceAfter = await ethers.provider.getBalance(accounts[0].address);
        // Check sender balance
        expect((balanceAfter - balanceBefore + txFee)).to.equal(ethers.parseEther('1'));

        // Check the state of the payment
        const payment = await etomicSwapV2.taker_payments(id);
        expect(payment.state).to.equal(BigInt(TAKER_REFUNDED));

        // Not allow to refund again
        await etomicSwapRunner0.refundTakerPayment(...refundParams).should.be.rejectedWith(INVALID_PAYMENT_STATE);
    });

    it('should allow taker to refund ERC20 payment after locktime', async function() {
        const lockTime = await currentEvmTime() + 1000;
        const params = [
            id,
            ethers.parseEther('0.9'),
            ethers.parseEther('0.1'),
            token.target,
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            lockTime,
            lockTime
        ];

        let etomicSwapRunner0 = etomicSwapV2.connect(accounts[0]);
        let etomicSwapRunner1 = etomicSwapV2.connect(accounts[1]);

        await token.approve(etomicSwapV2.target, ethers.parseEther('1'));
        // Make the ERC20 payment
        await expect(etomicSwapRunner0.erc20TakerPayment(...params)).to.be.fulfilled;

        const refundParams = [
            id,
            ethers.parseEther('0.9'),
            ethers.parseEther('0.1'),
            takerSecretHash,
            makerSecretHash,
            token.target,
            accounts[1].address
        ];

        await etomicSwapRunner0.refundTakerPayment(...refundParams).should.be.rejectedWith(REFUND_TIMESTAMP_NOT_REACHED);

        await advanceTimeAndMine(1000);

        // Not allow to call refund from non-sender address
        await etomicSwapRunner1.refundTakerPayment(id, ethers.parseEther('1'), ethers.parseEther('0.1'), takerSecretHash, makerSecretHash, token.target, accounts[1].address)
            .should.be.rejectedWith(INVALID_HASH);

        // Not allow to refund invalid amount
        await etomicSwapRunner0.refundTakerPayment(id, ethers.parseEther('2'), ethers.parseEther('0.1'), takerSecretHash, makerSecretHash, token.target, accounts[1].address).should.be.rejectedWith(INVALID_HASH);

        // Success refund
        const balanceBefore = await token.balanceOf(accounts[0].address);

        await etomicSwapRunner0.refundTakerPayment(...refundParams).should.be.fulfilled;

        const balanceAfter = await token.balanceOf(accounts[0].address);

        // Check sender balance
        expect((balanceAfter - balanceBefore)).to.equal(ethers.parseEther('1'));

        // Check the state of the payment
        const payment = await etomicSwapV2.taker_payments(id);
        expect(payment.state).to.equal(BigInt(TAKER_REFUNDED));

        // Do not allow to refund again
        await etomicSwapRunner0.refundTakerPayment(...refundParams).should.be.rejectedWith(INVALID_PAYMENT_STATE);
    });
});