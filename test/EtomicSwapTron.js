const {
    expect
} = require("chai");
const {
    ethers
} = require("hardhat");
const crypto = require('crypto');

require('chai')
    .use(require('chai-as-promised'))
    .should();

const INVALID_HASH = 'Invalid paymentHash';
const INVALID_PAYMENT_STATE = 'Invalid payment state. Must be PaymentSent';
const INVALID_TIMESTAMP = 'Current timestamp didn\'t exceed payment lock time';

async function advanceTimeAndMine(increaseAmount) {
    await ethers.provider.send("evm_increaseTime", [increaseAmount]);
    await ethers.provider.send("evm_mine");
}

async function currentEvmTime() {
    const block = await ethers.provider.getBlock("latest");
    return block.timestamp;
}

const id = '0x' + crypto.randomBytes(32).toString('hex');
const [PAYMENT_UNINITIALIZED, PAYMENT_SENT, RECEIVER_SPENT, SENDER_REFUNDED] = [0, 1, 2, 3];

const secret = crypto.randomBytes(32);
const secretHash = '0x' + crypto.createHash('sha256').update(secret).digest('hex');
const secretHex = '0x' + secret.toString('hex');

const invalidSecret = crypto.randomBytes(32);
const invalidSecretHex = '0x' + invalidSecret.toString('hex');

const zeroAddr = '0x0000000000000000000000000000000000000000';

describe("EtomicSwapTron", function() {

    beforeEach(async function() {
        accounts = await ethers.getSigners();

        EtomicSwapTron = await ethers.getContractFactory("EtomicSwapTron");
        etomicSwap = await EtomicSwapTron.deploy();
        await etomicSwap.waitForDeployment();

        Token = await ethers.getContractFactory("Token");
        token = await Token.deploy();
        await token.waitForDeployment();

        await token.transfer(accounts[1].address, ethers.parseEther('100'));
    });

    it('should create contract with uninitialized payments', async function() {
        const payment = await etomicSwap.payments(id);
        expect(Number(payment[2])).to.equal(PAYMENT_UNINITIALIZED);
    });

    it('should not allow ETH payment with zero receiver', async function() {
        const lockTime = await currentEvmTime() + 1000;
        await etomicSwap.connect(accounts[0]).ethPayment(
            id, zeroAddr, secretHash, lockTime,
            { value: ethers.parseEther('1') }
        ).should.be.rejectedWith("Receiver cannot be the zero address");
    });

    it('should not allow ETH payment with zero value', async function() {
        const lockTime = await currentEvmTime() + 1000;
        await etomicSwap.connect(accounts[0]).ethPayment(
            id, accounts[1].address, secretHash, lockTime,
            { value: 0 }
        ).should.be.rejectedWith("Payment amount must be greater than 0");
    });

    it('should not allow ERC20 payment with zero receiver', async function() {
        const lockTime = await currentEvmTime() + 1000;
        await token.approve(etomicSwap.target, ethers.parseEther('1'));
        await etomicSwap.connect(accounts[0]).erc20Payment(
            id, ethers.parseEther('1'), token.target, zeroAddr, secretHash, lockTime
        ).should.be.rejectedWith("Receiver cannot be the zero address");
    });

    it('should not allow ERC20 payment with zero token address', async function() {
        const lockTime = await currentEvmTime() + 1000;
        await etomicSwap.connect(accounts[0]).erc20Payment(
            id, ethers.parseEther('1'), zeroAddr, accounts[1].address, secretHash, lockTime
        ).should.be.rejectedWith("Token address cannot be zero");
    });

    it('should not allow ERC20 payment with zero amount', async function() {
        const lockTime = await currentEvmTime() + 1000;
        await etomicSwap.connect(accounts[0]).erc20Payment(
            id, 0, token.target, accounts[1].address, secretHash, lockTime
        ).should.be.rejectedWith("Payment amount must be greater than 0");
    });

    it('should allow to send ETH payment', async function() {
        const lockTime = await currentEvmTime() + 1000;
        const params = [
            id,
            accounts[1].address,
            secretHash,
            lockTime
        ];
        // Make the ETH payment
        await etomicSwap.connect(accounts[0]).ethPayment(...params, {
            value: ethers.parseEther('1')
        }).should.be.fulfilled;

        const payment = await etomicSwap.payments(id);

        expect(Number(payment[1])).to.equal(lockTime); // locktime
        expect(Number(payment[2])).to.equal(PAYMENT_SENT); // status

        // Check that it should not allow to send again
        await etomicSwap.connect(accounts[0]).ethPayment(...params, {
            value: ethers.parseEther('1')
        }).should.be.rejectedWith("ETH payment already initialized");
    });

    it('should store correct SHA-256 paymentHash for ETH payment', async function() {
        const lockTime = await currentEvmTime() + 1000;
        const amount = ethers.parseEther('1');

        await etomicSwap.connect(accounts[0]).ethPayment(
            id, accounts[1].address, secretHash, lockTime,
            { value: amount }
        ).should.be.fulfilled;

        const payment = await etomicSwap.payments(id);
        const storedHash = payment[0];

        // Compute expected paymentHash off-chain using solidityPacked + sha256
        const packed = ethers.solidityPacked(
            ['address', 'address', 'bytes32', 'address', 'uint256'],
            [accounts[1].address, accounts[0].address, secretHash, zeroAddr, amount]
        );
        const expectedHash = '0x' + crypto.createHash('sha256')
            .update(Buffer.from(packed.slice(2), 'hex'))
            .digest('hex');

        expect(storedHash).to.equal(expectedHash);
    });

    it('should store correct SHA-256 paymentHash for ERC20 payment', async function() {
        const lockTime = await currentEvmTime() + 1000;
        const amount = ethers.parseEther('1');

        await token.approve(etomicSwap.target, amount);
        await etomicSwap.connect(accounts[0]).erc20Payment(
            id, amount, token.target, accounts[1].address, secretHash, lockTime
        ).should.be.fulfilled;

        const payment = await etomicSwap.payments(id);
        const storedHash = payment[0];

        const packed = ethers.solidityPacked(
            ['address', 'address', 'bytes32', 'address', 'uint256'],
            [accounts[1].address, accounts[0].address, secretHash, token.target, amount]
        );
        const expectedHash = '0x' + crypto.createHash('sha256')
            .update(Buffer.from(packed.slice(2), 'hex'))
            .digest('hex');

        expect(storedHash).to.equal(expectedHash);
    });

    it('should allow to send ERC20 payment', async function() {
        const lockTime = await currentEvmTime() + 1000;
        const amount = ethers.parseEther('1');

        const params = [
            id,
            amount,
            token.target,
            accounts[1].address,
            secretHash,
            lockTime
        ];

        let etomicSwapRunner0 = etomicSwap.connect(accounts[0]);

        await token.approve(etomicSwap.target, ethers.parseEther('1'));
        // Make the ERC20 payment
        await etomicSwapRunner0.erc20Payment(...params).should.be.fulfilled;

        // Check contract token balance
        const balance = await token.balanceOf(etomicSwap.target);
        expect(balance).to.equal(ethers.parseEther('1'));

        const payment = await etomicSwap.payments(id);

        // Check locktime and status
        expect(payment[1]).to.equal(BigInt(lockTime));
        expect(payment[2]).to.equal(BigInt(PAYMENT_SENT));

        // Should not allow to deposit again
        await etomicSwapRunner0.erc20Payment(...params).should.be.rejectedWith("ERC20 payment already initialized");
    });

    it('should allow sender to refund ETH payment after locktime', async function() {
        const lockTime = await currentEvmTime() + 1000;
        const params = [
            id,
            accounts[1].address,
            secretHash,
            lockTime
        ];

        let etomicSwapRunner0 = etomicSwap.connect(accounts[0]);
        let etomicSwapRunner1 = etomicSwap.connect(accounts[1]);

        // Not allow to refund if payment was not sent
        await etomicSwapRunner0.senderRefund(id, ethers.parseEther('1'), secretHash, zeroAddr, accounts[1].address)
            .should.be.rejectedWith(INVALID_PAYMENT_STATE);

        // Make the ETH payment
        await etomicSwapRunner0.ethPayment(...params, {
            value: ethers.parseEther('1')
        }).should.be.fulfilled;

        // Not allow to refund before locktime
        await etomicSwapRunner0.senderRefund(id, ethers.parseEther('1'), secretHash, zeroAddr, accounts[1].address).should.be.rejectedWith(INVALID_TIMESTAMP);

        // Simulate time passing to exceed the locktime
        await advanceTimeAndMine(1000);

        // Not allow to call refund from non-sender address
        await etomicSwapRunner1.senderRefund(id, ethers.parseEther('1'), secretHash, zeroAddr, accounts[1].address).should.be.rejectedWith(INVALID_HASH);

        // Not allow to refund invalid amount
        await etomicSwapRunner0.senderRefund(id, ethers.parseEther('2'), secretHash, zeroAddr, accounts[1].address).should.be.rejectedWith(INVALID_HASH);

        // Success refund
        const balanceBefore = await ethers.provider.getBalance(accounts[0].address);
        const gasPrice = ethers.parseUnits('100', 'gwei');

        const tx = await etomicSwapRunner0.senderRefund(id, ethers.parseEther('1'), secretHash, zeroAddr, accounts[1].address, {
            gasPrice
        }).should.be.fulfilled;

        const receipt = await tx.wait();
        const gasUsed = ethers.parseUnits(receipt.gasUsed.toString(), 'wei');
        const txFee = gasUsed * gasPrice;

        const balanceAfter = await ethers.provider.getBalance(accounts[0].address);
        // Check sender balance
        expect((balanceAfter - balanceBefore + txFee)).to.equal(ethers.parseEther('1'));

        // Check the state of the payment
        const payment = await etomicSwap.payments(id);
        expect(payment.state).to.equal(BigInt(SENDER_REFUNDED));

        // Not allow to refund again
        await etomicSwapRunner0.senderRefund(id, ethers.parseEther('1'), secretHash, zeroAddr, accounts[1].address).should.be.rejectedWith(INVALID_PAYMENT_STATE);
    });

    it('should allow sender to refund ERC20 payment after locktime', async function() {
        const lockTime = await currentEvmTime() + 1000;
        const params = [
            id,
            ethers.parseEther('1'),
            token.target,
            accounts[1].address,
            secretHash,
            lockTime
        ];

        let etomicSwapRunner0 = etomicSwap.connect(accounts[0]);
        let etomicSwapRunner1 = etomicSwap.connect(accounts[1]);

        await token.approve(etomicSwap.target, ethers.parseEther('1'));
        // Make the ERC20 payment
        await expect(etomicSwapRunner0.erc20Payment(...params)).to.be.fulfilled;

        // Not allow to refund before locktime
        await etomicSwapRunner0.senderRefund(id, ethers.parseEther('1'), secretHash, token.target, accounts[1].address).should.be.rejectedWith(INVALID_TIMESTAMP);

        await advanceTimeAndMine(1000);

        // Not allow to call refund from non-sender address
        await etomicSwapRunner1.senderRefund(id, ethers.parseEther('1'), secretHash, token.target, accounts[1].address)
            .should.be.rejectedWith(INVALID_HASH);

        // Not allow to refund invalid amount
        await etomicSwapRunner0.senderRefund(id, ethers.parseEther('2'), secretHash, token.target, accounts[1].address).should.be.rejectedWith(INVALID_HASH);

        // Success refund
        const balanceBefore = await token.balanceOf(accounts[0].address);

        await etomicSwapRunner0.senderRefund(id, ethers.parseEther('1'), secretHash, token.target, accounts[1].address).should.be.fulfilled;

        const balanceAfter = await token.balanceOf(accounts[0].address);

        // Check sender balance
        expect((balanceAfter - balanceBefore)).to.equal(ethers.parseEther('1'));

        // Check the state of the payment
        const payment = await etomicSwap.payments(id);
        expect(payment.state).to.equal(BigInt(SENDER_REFUNDED));

        // Do not allow to refund again
        await etomicSwapRunner0.senderRefund(id, ethers.parseEther('1'), secretHash, token.target, accounts[1].address).should.be.rejectedWith(INVALID_PAYMENT_STATE);
    });

    it('should allow receiver to spend ETH payment by revealing a secret', async function() {
        const lockTime = await currentEvmTime() + 1000;
        const params = [
            id,
            accounts[1].address,
            secretHash,
            lockTime
        ];

        let etomicSwapRunner0 = etomicSwap.connect(accounts[0]);
        let etomicSwapRunner1 = etomicSwap.connect(accounts[1]);

        // Should not allow to spend uninitialized payment
        await etomicSwapRunner1.receiverSpend(id, ethers.parseEther('1'), secretHex, zeroAddr, accounts[0].address).should.be.rejectedWith(INVALID_PAYMENT_STATE);

        // Make the ETH payment
        await etomicSwapRunner0.ethPayment(...params, {
            value: ethers.parseEther('1')
        }).should.be.fulfilled;

        // Should not allow to spend with invalid secret
        await etomicSwapRunner1.receiverSpend(id, ethers.parseEther('1'), invalidSecretHex, zeroAddr, accounts[0].address).should.be.rejectedWith(INVALID_HASH);

        // Should not allow to spend invalid amount
        await etomicSwapRunner1.receiverSpend(id, ethers.parseEther('2'), secretHex, zeroAddr, accounts[0].address).should.be.rejectedWith(INVALID_HASH);

        // Should not allow to claim from non-receiver address even with valid secret
        await etomicSwapRunner0.receiverSpend(id, ethers.parseEther('1'), secretHex, zeroAddr, accounts[0].address).should.be.rejectedWith(INVALID_HASH);

        // Success spend
        const balanceBefore = await ethers.provider.getBalance(accounts[1].address);

        const gasPrice = ethers.parseUnits('100', 'gwei');

        const tx = await etomicSwapRunner1.receiverSpend(id, ethers.parseEther('1'), secretHex, zeroAddr, accounts[0].address, {
            gasPrice
        }).should.be.fulfilled;

        const receipt = await tx.wait();
        const gasUsed = ethers.parseUnits(receipt.gasUsed.toString(), 'wei');
        const txFee = gasPrice * gasUsed;

        const balanceAfter = await ethers.provider.getBalance(accounts[1].address);
        // Check receiver balance
        expect((balanceAfter - balanceBefore + txFee)).to.equal(ethers.parseEther('1'));

        // Check the state of the payment
        const payment = await etomicSwap.payments(id);
        expect(payment.state).to.equal(BigInt(RECEIVER_SPENT));

        // Should not allow to spend again
        await etomicSwapRunner1.receiverSpend(id, ethers.parseEther('1'), secretHex, zeroAddr, accounts[0].address, {
            gasPrice
        }).should.be.rejectedWith(INVALID_PAYMENT_STATE);
    });

    it('should allow receiver to spend ERC20 payment by revealing a secret', async function() {
        const lockTime = await currentEvmTime() + 1000;
        const params = [
            id,
            ethers.parseEther('1'),
            token.target,
            accounts[1].address,
            secretHash,
            lockTime
        ];

        let etomicSwapRunner0 = etomicSwap.connect(accounts[0]);
        let etomicSwapRunner1 = etomicSwap.connect(accounts[1]);

        // Should not allow to spend uninitialized payment
        await etomicSwapRunner1.receiverSpend(id, ethers.parseEther('1'), secretHex, token.target, accounts[0].address).should.be.rejectedWith(INVALID_PAYMENT_STATE);

        await token.approve(etomicSwap.target, ethers.parseEther('1'));
        // Make the ERC20 payment
        await etomicSwapRunner0.erc20Payment(...params).should.be.fulfilled;

        // Should not allow to spend with invalid secret
        await etomicSwapRunner1.receiverSpend(id, ethers.parseEther('1'), invalidSecretHex, token.target, accounts[0].address).should.be.rejectedWith(INVALID_HASH);

        // Should not allow to spend invalid amount
        await etomicSwapRunner1.receiverSpend(id, ethers.parseEther('2'), secretHex, token.target, accounts[0].address).should.be.rejectedWith(INVALID_HASH);

        // Should not allow to claim from non-receiver address even with valid secret
        await etomicSwapRunner0.receiverSpend(id, ethers.parseEther('1'), secretHex, token.target, accounts[0].address).should.be.rejectedWith(INVALID_HASH);

        // Success spend
        const balanceBefore = await token.balanceOf(accounts[1].address);

        const gasPrice = ethers.parseUnits('100', 'gwei');

        await etomicSwapRunner1.receiverSpend(id, ethers.parseEther('1'), secretHex, token.target, accounts[0].address, {
            gasPrice
        }).should.be.fulfilled;

        const balanceAfter = await token.balanceOf(accounts[1].address);
        // Check receiver balance
        expect((balanceAfter - balanceBefore)).to.equal(ethers.parseEther('1'));

        // Check the state of the payment
        const payment = await etomicSwap.payments(id);
        expect(payment.state).to.equal(BigInt(RECEIVER_SPENT));

        // Should not allow to spend again
        await etomicSwapRunner1.receiverSpend(id, ethers.parseEther('1'), secretHex, token.target, accounts[0].address, {
            gasPrice
        }).should.be.rejectedWith(INVALID_PAYMENT_STATE);
    });

    it('should allow receiver to spend ETH payment by revealing a secret even after locktime', async function() {
        const lockTime = await currentEvmTime() + 1000;
        const params = [
            id,
            accounts[1].address,
            secretHash,
            lockTime
        ];

        let etomicSwapRunner0 = etomicSwap.connect(accounts[0]);
        let etomicSwapRunner1 = etomicSwap.connect(accounts[1]);

        // Make the ETH payment
        await etomicSwapRunner0.ethPayment(...params, {
            value: ethers.parseEther('1')
        }).should.be.fulfilled;

        await advanceTimeAndMine(1000);

        // Success spend
        const balanceBefore = await ethers.provider.getBalance(accounts[1].address);

        const gasPrice = ethers.parseUnits('100', 'gwei');

        const tx = await etomicSwapRunner1.receiverSpend(id, ethers.parseEther('1'), secretHex, zeroAddr, accounts[0].address, {
            gasPrice
        }).should.be.fulfilled;

        const receipt = await tx.wait();
        const gasUsed = ethers.parseUnits(receipt.gasUsed.toString(), 'wei');
        const txFee = gasPrice * gasUsed;

        const balanceAfter = await ethers.provider.getBalance(accounts[1].address);
        // Check receiver balance
        expect((balanceAfter - balanceBefore + txFee)).to.equal(ethers.parseEther('1'));

        const payment = await etomicSwap.payments(id);
        expect(payment.state).to.equal(BigInt(RECEIVER_SPENT));

        // Should not allow to spend again
        await etomicSwapRunner1.receiverSpend(id, ethers.parseEther('1'), secretHex, zeroAddr, accounts[0].address, {
            gasPrice
        }).should.be.rejectedWith(INVALID_PAYMENT_STATE);
    });

    it('should allow receiver to spend ERC20 payment by revealing a secret even after locktime', async function() {
        const lockTime = await currentEvmTime() + 1000;
        const params = [
            id,
            ethers.parseEther('1'),
            token.target,
            accounts[1].address,
            secretHash,
            lockTime
        ];

        let etomicSwapRunner0 = etomicSwap.connect(accounts[0]);
        let etomicSwapRunner1 = etomicSwap.connect(accounts[1]);

        await token.approve(etomicSwap.target, ethers.parseEther('1'));
        // Make the ERC20 payment
        await expect(etomicSwapRunner0.erc20Payment(...params)).to.be.fulfilled;

        await advanceTimeAndMine(1000);

        // Success spend
        const balanceBefore = await token.balanceOf(accounts[1].address);
        const gasPrice = ethers.parseUnits('100', 'gwei');

        await etomicSwapRunner1.receiverSpend(id, ethers.parseEther('1'), secretHex, token.target, accounts[0].address, {
            gasPrice
        }).should.be.fulfilled;

        const balanceAfter = await token.balanceOf(accounts[1].address);
        // Check receiver balance
        expect((balanceAfter - balanceBefore)).to.equal(ethers.parseEther('1'));

        // Check the state of the payment
        const payment = await etomicSwap.payments(id);
        expect(payment.state).to.equal(BigInt(RECEIVER_SPENT));

        // Should not allow to spend again
        await etomicSwapRunner1.receiverSpend(id, ethers.parseEther('1'), secretHex, token.target, accounts[0].address, {
            gasPrice
        }).should.be.rejectedWith(INVALID_PAYMENT_STATE);
    });

});
