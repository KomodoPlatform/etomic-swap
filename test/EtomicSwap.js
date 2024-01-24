const { expect } = require("chai");
const { ethers} = require("hardhat");
const crypto = require('crypto');
const RIPEMD160 = require('ripemd160');
const {AbiCoder} = require("ethers");

require('chai')
    .use(require('chai-as-promised'))
    .should();

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
const [PAYMENT_UNINITIALIZED, PAYMENT_SENT, RECEIVER_SPENT, SENDER_REFUNDED] = [0, 1, 2, 3];

const secret = crypto.randomBytes(32);
const secretHash = '0x' + new RIPEMD160().update(crypto.createHash('sha256').update(secret).digest()).digest('hex');
const secretHex = '0x' + secret.toString('hex');

const invalidSecret = crypto.randomBytes(32);
const invalidSecretHex = '0x' + invalidSecret.toString('hex');

const zeroAddr = '0x0000000000000000000000000000000000000000';

describe("EtomicSwap", function() {

    beforeEach(async function() {
        accounts = await ethers.getSigners();


        EtomicSwap = await ethers.getContractFactory("EtomicSwap");
        etomicSwap = await EtomicSwap.deploy();
        etomicSwap.waitForDeployment();

        Token = await ethers.getContractFactory("Token");
        token = await Token.deploy();
        token.waitForDeployment();

        Erc721Token = await ethers.getContractFactory("Erc721Token");
        erc721token = await Erc721Token.deploy("MyNFT", "MNFT");
        erc721token.waitForDeployment();

        Erc1155Token = await ethers.getContractFactory("Erc1155Token");
        erc1155token = await Erc1155Token.deploy("uri");
        erc1155token.waitForDeployment();

        await token.transfer(accounts[1].address, ethers.parseEther('100'));
    });

    it('should create contract with uninitialized payments', async function() {
        const payment = await etomicSwap.payments(id);
        expect(Number(payment[2])).to.equal(PAYMENT_UNINITIALIZED);
    });

    it('should have correct ERC1155 token balance', async function() {
        const amount = 3;
        const tokenId = 1;
        const balance = await erc1155token.balanceOf(accounts[0].address, tokenId);
        expect(Number(balance)).to.equal(amount, "Balance of ERC1155 tokens in EtomicSwap contract is incorrect");
    });

    it('should allow to send ETH payment', async function() {
        const lockTime = await currentEvmTime() + 1000;
        const params = [
            id,
            accounts[1].address,
            secretHash,
            lockTime
        ];
        await etomicSwap.ethPayment(...params, { value: ethers.parseEther('1') }).should.be.fulfilled;

        const payment = await etomicSwap.payments(id);

        expect(Number(payment[1])).to.equal(lockTime); // locktime
        expect(Number(payment[2])).to.equal(PAYMENT_SENT); // status

        // Check that it should not allow to send again
        await etomicSwap.ethPayment(...params, { value: ethers.parseEther('1') }).should.be.rejected;
    });

    it('should allow to send ERC20 payment', async function () {
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

        await token.approve(etomicSwap.target, ethers.parseEther('1'));
        await etomicSwap.erc20Payment(...params).should.be.fulfilled;

        // Check contract token balance
        const balance = await token.balanceOf(etomicSwap.target);
        expect(balance).to.equal(ethers.parseEther('1'));

        const payment = await etomicSwap.payments(id);

        // Check locktime and status
        expect(payment[1]).to.equal(BigInt(lockTime));
        expect(payment[2]).to.equal(BigInt(PAYMENT_SENT));

        // should not allow to deposit again
        await etomicSwap.erc20Payment(...params).should.be.rejected;
    });

    it('should allow to send ERC721 payment', async function () {
        const lockTime = await currentEvmTime() + 1000;
        const tokenId = 1; // Assuming token ID 1 is minted to accounts[0] in Erc721Token contract

        const abiCoder = new AbiCoder();
        const data = abiCoder.encode(
            ['bytes32', 'address', 'address', 'bytes20', 'uint64'],
            [id, accounts[1].address, erc721token.target, secretHash, lockTime]
        );
        // Call safeTransferFrom directly to transfer the token to the EtomicSwap contract.
        // Explicitly specify the method signature.
        await erc721token['safeTransferFrom(address,address,uint256,bytes)'](
            accounts[0].address,
            etomicSwap.target,
            tokenId,
            data
        );
        // Check the payment lockTime and state
        const payment = await etomicSwap.payments(id);
        expect(payment.lockTime).to.equal(BigInt(lockTime));
        expect(payment.state).to.equal(BigInt(PAYMENT_SENT));

        // Check the ownership of the token
        const tokenOwner = await erc721token.ownerOf(tokenId);
        expect(tokenOwner).to.equal(etomicSwap.target);

        // Should not allow to send again
        await erc721token['safeTransferFrom(address,address,uint256,bytes)'](
            accounts[0].address,
            etomicSwap.target,
            tokenId,
            data)
            .should.be.rejected;
    });

    it('should allow to send ERC1155 payment', async function () {
        const lockTime = await currentEvmTime() + 1000;
        const tokenId = 1; // Token ID used in Erc1155Token contract
        const amountToSend = 2; // Amount of tokens to send

        const abiCoder = new AbiCoder();
        const data = abiCoder.encode(
            ['bytes32', 'address', 'address', 'bytes20', 'uint64'],
            [id, accounts[1].address, erc1155token.target, secretHash, lockTime]
        );
        // Call safeTransferFrom directly to transfer the tokens to the EtomicSwap contract
        await erc1155token.safeTransferFrom(
            accounts[0].address,
            etomicSwap.target,
            tokenId,
            amountToSend,
            data
        );

        // Check the payment lockTime and state
        const payment = await etomicSwap.payments(id);
        expect(payment.lockTime).to.equal(BigInt(lockTime));
        expect(payment.state).to.equal(BigInt(PAYMENT_SENT));

        // Check the balance of the token in the swap contract
        const tokenBalance = await erc1155token.balanceOf(etomicSwap.target, tokenId);
        expect(tokenBalance).to.equal(BigInt(amountToSend));

        // Check sending same params again - should fail
        await erc1155token.safeTransferFrom(
            accounts[0].address,
            etomicSwap.target,
            tokenId,
            amountToSend,
            data
        ).should.be.rejected

        // sender should be capable to send more tokens, if they have it
        const id1 = '0x' + crypto.randomBytes(32).toString('hex');
        const data1 = abiCoder.encode(
            ['bytes32', 'address', 'address', 'bytes20', 'uint64'],
            [id1, accounts[1].address, erc1155token.target, secretHash, lockTime]
        );
        await erc1155token.safeTransferFrom(accounts[0].address, etomicSwap.target, tokenId, 1, data1).should.be.fulfilled;

        // Check sending more tokens than the sender owns - should fail
        const id2 = '0x' + crypto.randomBytes(32).toString('hex');
        const data2 = abiCoder.encode(
            ['bytes32', 'address', 'address', 'bytes20', 'uint64'],
            [id2, accounts[1].address, erc1155token.target, secretHash, lockTime]
        );
        await erc1155token.safeTransferFrom(accounts[0].address, etomicSwap.target, tokenId, 1, data2).should.be.rejected;
    });

    it('should allow sender to refund ETH payment after locktime', async function () {
        const lockTime = await currentEvmTime() + 1000;
        const params = [
            id,
            accounts[1].address,
            secretHash,
            lockTime
        ];

        // Not allow to refund if payment was not sent
        await etomicSwap.senderRefund(id, ethers.parseEther('1'), secretHash, zeroAddr, accounts[1].address)
            .should.be.rejected;

        await etomicSwap.ethPayment(...params, { value: ethers.parseEther('1') }).should.be.fulfilled;

        // Not allow to refund before locktime
        await etomicSwap.senderRefund(id, ethers.parseEther('1'), secretHash, zeroAddr, accounts[1].address).should.be.rejected;

        // Simulate time passing to exceed the locktime
        await advanceTimeAndMine(1000);

        // Not allow to call refund from non-sender address
        await etomicSwap.senderRefund(id, ethers.parseEther('1'), secretHash, zeroAddr, accounts[1].address, { from: accounts[1] })
            .should.be.rejected;

        // Not allow to refund invalid amount
        await etomicSwap.senderRefund(id, ethers.parseEther('2'), secretHash, zeroAddr, accounts[1].address).should.be.rejected;

        // Success refund
        const balanceBefore = await ethers.provider.getBalance(accounts[0].address);
        const gasPrice = ethers.parseUnits('100', 'gwei');

        const tx = await etomicSwap.senderRefund(id, ethers.parseEther('1'), secretHash, zeroAddr, accounts[1].address, { gasPrice }).should.be.fulfilled;
        const receipt = await tx.wait();

        const balanceAfter = await ethers.provider.getBalance(accounts[0].address);

        const gasUsed = ethers.parseUnits(receipt.gasUsed.toString(), 'wei');
        const txFee = gasUsed * gasPrice;
        // Check sender balance
        expect((balanceAfter - balanceBefore + txFee)).to.equal(ethers.parseEther('1'));

        const payment = await etomicSwap.payments(id);
        expect(payment.state).to.equal(BigInt(SENDER_REFUNDED));

        // Not allow to refund again
        await etomicSwap.senderRefund(id, ethers.parseEther('1'), secretHash, zeroAddr, accounts[1].address).should.be.rejected;
    });

    it('should allow sender to refund ERC20 payment after locktime', async function () {
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

        await token.approve(etomicSwap.target, ethers.parseEther('1'));
        await expect(etomicSwap.erc20Payment(...params)).to.be.fulfilled;

        // Not allow to refund if payment was not sent
        await etomicSwap.senderRefund(id, ethers.parseEther('1'), secretHash, token.target, accounts[1].address).should.be.rejected;

        // not allow to refund before locktime
        await etomicSwap.senderRefund(id, ethers.parseEther('1'), secretHash, token.target, accounts[1].address).should.be.rejected;

        await advanceTimeAndMine(1000);

        // Not allow to call refund from non-sender address
        await etomicSwap.senderRefund(id, ethers.parseEther('1'), secretHash, token.target, accounts[1].address, { from: accounts[1].address })
            .should.be.rejected;

        // Not allow to refund invalid amount
        await etomicSwap.senderRefund(id, ethers.parseEther('2'), secretHash, token.target, accounts[1].address).should.be.rejected;

        // Success refund
        const balanceBefore = await token.balanceOf(accounts[0].address);

        await etomicSwap.senderRefund(id, ethers.parseEther('1'), secretHash, token.target, accounts[1].address).should.be.fulfilled;

        const balanceAfter = await token.balanceOf(accounts[0].address);

        // Check sender balance
        expect((balanceAfter - balanceBefore)).to.equal(ethers.parseEther('1'));

        const payment = await etomicSwap.payments(id);
        expect(payment.state).to.equal(BigInt(SENDER_REFUNDED));

        // Do not allow to refund again
        await etomicSwap.senderRefund(id, ethers.parseEther('1'), secretHash, token.target, accounts[1].address).should.be.rejected;
    });

    /**
    it('should allow sender to refund ERC721 payment after locktime', async function () {
        const lockTime = await currentEvmTime() + 1000;
        const tokenId = 1;

        const data = web3.eth.abi.encodeParameters(
            ['bytes32', 'address', 'address', 'bytes20', 'uint64'],
            [id, accounts[1], this.erc721token.address, secretHash, lockTime]
        );
        // Call safeTransferFrom directly to transfer the token to the EtomicSwap contract
        await this.erc721token.safeTransferFrom(accounts[0], this.swap.address, tokenId, data).should.be.fulfilled;

        // Attempt refund before locktime - should fail
        await this.swap.senderRefundErc721(id, secretHash, this.erc721token.address, tokenId, accounts[1], { from: accounts[0] }).should.be.rejectedWith(EVMThrow);

        // Advance time past locktime
        await advanceTimeAndMine(1000);

        // Attempt refund from non-sender address - should fail
        await this.swap.senderRefundErc721(id, secretHash, this.erc721token.address, tokenId, accounts[1], { from: accounts[1] }).should.be.rejectedWith(EVMThrow);

        // Successful refund by sender after locktime
        await this.swap.senderRefundErc721(id, secretHash, this.erc721token.address, tokenId, accounts[1], { from: accounts[0] }).should.be.fulfilled;

        // Check the state of the payment
        const payment = await this.swap.payments(id);
        assert.equal(payment[2].valueOf(), SENDER_REFUNDED);

        // Check the ownership of the token - should be back to the sender (accounts[0])
        const tokenOwner = await this.erc721token.ownerOf(tokenId);
        assert.equal(tokenOwner, accounts[0]);

        // Attempting refund again - should fail
        await this.swap.senderRefundErc721(id, secretHash, this.erc721token.address, tokenId, accounts[1], { from: accounts[0] }).should.be.rejectedWith(EVMThrow);
    });

    it('should allow sender to refund ERC1155 payment after locktime', async function () {
        const lockTime = await currentEvmTime() + 1000;
        const tokenId = 1; // Token ID used in Erc1155Token contract
        const amountToSend = 3; // Amount of tokens to send

        const data = web3.eth.abi.encodeParameters(
            ['bytes32', 'address', 'address', 'bytes20', 'uint64'],
            [id, accounts[1], this.erc1155token.address, secretHash, lockTime]
        );
        // Call safeTransferFrom directly to transfer the tokens to the EtomicSwap contract
        await this.erc1155token.safeTransferFrom(accounts[0], this.swap.address, tokenId, amountToSend, data).should.be.fulfilled;

        // Attempt refund before locktime - should fail
        await this.swap.senderRefundErc1155(id, amountToSend, secretHash, this.erc1155token.address, tokenId, accounts[1], { from: accounts[0] }).should.be.rejectedWith(EVMThrow);

        // Advance time past locktime
        await advanceTimeAndMine(1000);

        // Attempt refund from non-sender address - should fail
        await this.swap.senderRefundErc1155(id, amountToSend, secretHash, this.erc1155token.address, tokenId, accounts[1], { from: accounts[1] }).should.be.rejectedWith(EVMThrow);

        // Successful refund by sender after locktime
        await this.swap.senderRefundErc1155(id, amountToSend, secretHash, this.erc1155token.address, tokenId, accounts[1], { from: accounts[0] }).should.be.fulfilled;

        // Check the state of the payment
        const payment = await this.swap.payments(id);
        assert.equal(payment[2].valueOf(), SENDER_REFUNDED);

        // Check the balance of the token - should be back to the sender (accounts[0])
        const tokenBalance = await this.erc1155token.balanceOf(accounts[0], tokenId);
        assert.equal(tokenBalance.toNumber(), amountToSend);

        // Attempting refund again - should fail
        await this.swap.senderRefundErc1155(id, amountToSend, secretHash, this.erc1155token.address, tokenId, accounts[1], { from: accounts[0] }).should.be.rejectedWith(EVMThrow);
    });

    it('should allow receiver to spend ETH payment by revealing a secret', async function () {
        const lockTime = await currentEvmTime() + 1000;
        const params = [
            id,
            accounts[1],
            secretHash,
            lockTime
        ];

        // should not allow to spend uninitialized payment
        await this.swap.receiverSpend(id, web3.utils.toWei('1'), secretHex, zeroAddr, accounts[0], { from: accounts[1] }).should.be.rejectedWith(EVMThrow);

        await this.swap.ethPayment(...params, { value: web3.utils.toWei('1') }).should.be.fulfilled;

        // should not allow to spend with invalid secret
        await this.swap.receiverSpend(id, web3.utils.toWei('1'), invalidSecretHex, zeroAddr, accounts[0], { from: accounts[1] }).should.be.rejectedWith(EVMThrow);
        // should not allow to spend invalid amount
        await this.swap.receiverSpend(id, web3.utils.toWei('2'), secretHex, zeroAddr, accounts[0], { from: accounts[1] }).should.be.rejectedWith(EVMThrow);

        // should not allow to claim from non-receiver address even with valid secret
        await this.swap.receiverSpend(id, web3.utils.toWei('1'), secretHex, zeroAddr, accounts[0], { from: accounts[0] }).should.be.rejectedWith(EVMThrow);

        // success spend
        const balanceBefore = web3.utils.toBN(await web3.eth.getBalance(accounts[1]));
        const gasPrice = web3.utils.toWei('100', 'gwei');

        const tx = await this.swap.receiverSpend(id, web3.utils.toWei('1'), secretHex, zeroAddr, accounts[0], { from: accounts[1], gasPrice }).should.be.fulfilled;
        const txFee = web3.utils.toBN(gasPrice).mul(web3.utils.toBN(tx.receipt.gasUsed));

        const balanceAfter = web3.utils.toBN(await web3.eth.getBalance(accounts[1]));

        // check receiver balance
        assert.equal(balanceAfter.sub(balanceBefore).add(txFee).toString(), web3.utils.toWei('1'));

        const payment = await this.swap.payments(id);

        // status
        assert.equal(payment[2].valueOf(), RECEIVER_SPENT);

        // should not allow to spend again
        await this.swap.receiverSpend(id, web3.utils.toWei('1'), secretHex, zeroAddr, accounts[0], { from: accounts[1], gasPrice }).should.be.rejectedWith(EVMThrow);
    });

    it('should allow receiver to spend ERC20 payment by revealing a secret', async function () {
        const lockTime = await currentEvmTime() + 1000;
        const params = [
            id,
            web3.utils.toWei('1'),
            this.token.address,
            accounts[1],
            secretHash,
            lockTime
        ];

        // should not allow to spend uninitialized payment
        await this.swap.receiverSpend(id, web3.utils.toWei('1'), secretHex, this.token.address, accounts[0], { from: accounts[1] }).should.be.rejectedWith(EVMThrow);

        await this.token.approve(this.swap.address, web3.utils.toWei('1'));
        await this.swap.erc20Payment(...params).should.be.fulfilled;

        // should not allow to spend with invalid secret
        await this.swap.receiverSpend(id, web3.utils.toWei('1'), invalidSecretHex, this.token.address, accounts[0], { from: accounts[1] }).should.be.rejectedWith(EVMThrow);
        // should not allow to spend invalid amount
        await this.swap.receiverSpend(id, web3.utils.toWei('2'), secretHex, this.token.address, accounts[0], { from: accounts[1] }).should.be.rejectedWith(EVMThrow);

        // should not allow to claim from non-receiver address even with valid secret
        await this.swap.receiverSpend(id, web3.utils.toWei('1'), secretHex, this.token.address, accounts[0], { from: accounts[0] }).should.be.rejectedWith(EVMThrow);

        // success spend
        const balanceBefore = web3.utils.toBN(await this.token.balanceOf(accounts[1]));

        const gasPrice = web3.utils.toWei('100', 'gwei');
        await this.swap.receiverSpend(id, web3.utils.toWei('1'), secretHex, this.token.address, accounts[0], { from: accounts[1], gasPrice }).should.be.fulfilled;
        const balanceAfter = web3.utils.toBN(await this.token.balanceOf(accounts[1]));

        // check receiver balance
        assert.equal(balanceAfter.sub(balanceBefore).toString(), web3.utils.toWei('1'));

        const payment = await this.swap.payments(id);

        // status
        assert.equal(payment[2].valueOf(), RECEIVER_SPENT);

        // should not allow to spend again
        await this.swap.receiverSpend(id, web3.utils.toWei('1'), secretHex, this.token.address, accounts[0], { from: accounts[1], gasPrice }).should.be.rejectedWith(EVMThrow);
    });

    it('should allow receiver to spend ERC721 payment by revealing a secret', async function () {
        const lockTime = await currentEvmTime() + 1000;
        const tokenId = 1; // Assuming token ID 1 is minted to accounts[0]

        const data = web3.eth.abi.encodeParameters(
            ['bytes32', 'address', 'address', 'bytes20', 'uint64'],
            [id, accounts[1], this.erc721token.address, secretHash, lockTime]
        );
        // Call safeTransferFrom directly to transfer the token to the EtomicSwap contract
        await this.erc721token.safeTransferFrom(accounts[0], this.swap.address, tokenId, data).should.be.fulfilled;

        // Check the ownership of the token before receiver spend payment - should be owned by swap contract
        const tokenOwnerBeforeReceiverSpend = await this.erc721token.ownerOf(tokenId);
        assert.equal(tokenOwnerBeforeReceiverSpend, this.swap.address);

        // Attempt to spend with invalid secret - should fail
        await this.swap.receiverSpendErc721(id, invalidSecretHex, this.erc721token.address, tokenId, accounts[0], { from: accounts[1] }).should.be.rejectedWith(EVMThrow);

        // Attempt to claim from non-receiver address even with valid secret - should fail
        await this.swap.receiverSpendErc721(id, secretHex, this.erc721token.address, tokenId, accounts[0], { from: accounts[0] }).should.be.rejectedWith(EVMThrow);

        // Successful spend by receiver with valid secret
        await this.swap.receiverSpendErc721(id, secretHex, this.erc721token.address, tokenId, accounts[0], { from: accounts[1] }).should.be.fulfilled;

        // Check the state of the payment
        const payment = await this.swap.payments(id);
        assert.equal(payment[2].valueOf(), RECEIVER_SPENT);

        // Check the ownership of the token - should be transferred to the receiver (accounts[1])
        const tokenOwner = await this.erc721token.ownerOf(tokenId);
        assert.equal(tokenOwner, accounts[1]);

        // Attempting to spend again - should fail
        await this.swap.receiverSpendErc721(id, secretHex, this.erc721token.address, tokenId, accounts[0], { from: accounts[1] }).should.be.rejectedWith(EVMThrow);
    });

    it('should allow receiver to spend ERC1155 payment by revealing a secret', async function () {
        const lockTime = await currentEvmTime() + 1000;
        const tokenId = 1; // Token ID used in Erc1155Token contract
        const amountToSend = 2; // Amount of tokens to send

        const data = web3.eth.abi.encodeParameters(
            ['bytes32', 'address', 'address', 'bytes20', 'uint64'],
            [id, accounts[1], this.erc1155token.address, secretHash, lockTime]
        );
        // Call safeTransferFrom directly to transfer the tokens to the EtomicSwap contract
        await this.erc1155token.safeTransferFrom(accounts[0], this.swap.address, tokenId, amountToSend, data).should.be.fulfilled;

        // Check the balance of the token before receiver spend payment - should be in swap contract
        let tokenBalanceBeforeReceiverSpend = await this.erc1155token.balanceOf(this.swap.address, tokenId);
        assert.equal(tokenBalanceBeforeReceiverSpend.toNumber(), amountToSend);

        // Attempt to spend with invalid secret - should fail
        await this.swap.receiverSpendErc1155(id, amountToSend, invalidSecretHex, this.erc1155token.address, tokenId, accounts[0], { from: accounts[1] }).should.be.rejectedWith(EVMThrow);

        // Attempt to claim from non-receiver address even with valid secret - should fail
        await this.swap.receiverSpendErc1155(id, amountToSend, secretHex, this.erc1155token.address, tokenId, accounts[0], { from: accounts[0] }).should.be.rejectedWith(EVMThrow);

        // Successful spend by receiver with valid secret
        await this.swap.receiverSpendErc1155(id, amountToSend, secretHex, this.erc1155token.address, tokenId, accounts[0], { from: accounts[1] }).should.be.fulfilled;

        // Check the state of the payment
        const payment = await this.swap.payments(id);
        assert.equal(payment[2].valueOf(), RECEIVER_SPENT);

        // Check the balance of the token - should be transferred to the receiver (accounts[1])
        let tokenBalance = await this.erc1155token.balanceOf(accounts[1], tokenId);
        assert.equal(tokenBalance.toNumber(), amountToSend);

        // Check that the swap contract no longer holds the tokens
        tokenBalance = await this.erc1155token.balanceOf(this.swap.address, tokenId);
        assert.equal(tokenBalance.toNumber(), 0);

        // Attempting to spend again - should fail
        await this.swap.receiverSpendErc1155(id, amountToSend, secretHex, this.erc1155token.address, tokenId, accounts[0], { from: accounts[1] }).should.be.rejectedWith(EVMThrow);
    });

    it('should allow receiver to spend ETH payment by revealing a secret even after locktime', async function () {
        const lockTime = await currentEvmTime() + 1000;
        const params = [
            id,
            accounts[1],
            secretHash,
            lockTime
        ];

        await this.swap.ethPayment(...params, { value: web3.utils.toWei('1') }).should.be.fulfilled;

        await advanceTimeAndMine(1000);

        // success spend
        const balanceBefore = web3.utils.toBN(await web3.eth.getBalance(accounts[1]));
        const gasPrice = web3.utils.toWei('100', 'gwei');

        const tx = await this.swap.receiverSpend(id, web3.utils.toWei('1'), secretHex, zeroAddr, accounts[0], { from: accounts[1], gasPrice }).should.be.fulfilled;
        const txFee = web3.utils.toBN(gasPrice).mul(web3.utils.toBN(tx.receipt.gasUsed));

        const balanceAfter = web3.utils.toBN(await web3.eth.getBalance(accounts[1]));

        // check receiver balance
        assert.equal(balanceAfter.sub(balanceBefore).add(txFee).toString(), web3.utils.toWei('1'));

        const payment = await this.swap.payments(id);

        // status
        assert.equal(payment[2].valueOf(), RECEIVER_SPENT);

        // should not allow to spend again
        await this.swap.receiverSpend(id, web3.utils.toWei('1'), secretHex, zeroAddr, accounts[0], { from: accounts[1], gasPrice }).should.be.rejectedWith(EVMThrow);
    });

    it('should allow receiver to spend ERC20 payment by revealing a secret even after locktime', async function () {
        const lockTime = await currentEvmTime() + 1000;
        const params = [
            id,
            web3.utils.toWei('1'),
            this.token.address,
            accounts[1],
            secretHash,
            lockTime
        ];

        await this.token.approve(this.swap.address, web3.utils.toWei('1'));
        await this.swap.erc20Payment(...params).should.be.fulfilled;

        await advanceTimeAndMine(1000);

        // success spend
        const balanceBefore = web3.utils.toBN(await this.token.balanceOf(accounts[1]));

        const gasPrice = web3.utils.toWei('100', 'gwei');
        await this.swap.receiverSpend(id, web3.utils.toWei('1'), secretHex, this.token.address, accounts[0], { from: accounts[1], gasPrice }).should.be.fulfilled;
        const balanceAfter = web3.utils.toBN(await this.token.balanceOf(accounts[1]));

        // check receiver balance
        assert.equal(balanceAfter.sub(balanceBefore).toString(), web3.utils.toWei('1'));

        const payment = await this.swap.payments(id);

        // status
        assert.equal(payment[2].valueOf(), RECEIVER_SPENT);

        // should not allow to spend again
        await this.swap.receiverSpend(id, web3.utils.toWei('1'), secretHex, this.token.address, accounts[0], { from: accounts[1], gasPrice }).should.be.rejectedWith(EVMThrow);
    });

    it('should allow receiver to spend ERC721 payment by revealing a secret even after locktime', async function () {
        const lockTime = await currentEvmTime() + 1000;
        const tokenId = 1; // Assuming token ID 1 is minted to accounts[0]

        const data = web3.eth.abi.encodeParameters(
            ['bytes32', 'address', 'address', 'bytes20', 'uint64'],
            [id, accounts[1], this.erc721token.address, secretHash, lockTime]
        );
        // Call safeTransferFrom directly to transfer the token to the EtomicSwap contract
        await this.erc721token.safeTransferFrom(accounts[0], this.swap.address, tokenId, data).should.be.fulfilled;

        await advanceTimeAndMine(1000);

        // Successful spend by receiver with valid secret even after locktime
        await this.swap.receiverSpendErc721(id, secretHex, this.erc721token.address, tokenId, accounts[0], { from: accounts[1] }).should.be.fulfilled;

        // Check the state of the payment
        const payment = await this.swap.payments(id);
        assert.equal(payment[2].valueOf(), RECEIVER_SPENT);

        // Check the ownership of the token - should be transferred to the receiver (accounts[1])
        const tokenOwner = await this.erc721token.ownerOf(tokenId);
        assert.equal(tokenOwner, accounts[1]);

        // Attempting to spend again - should fail
        await this.swap.receiverSpendErc721(id, secretHex, this.erc721token.address, tokenId, accounts[0], { from: accounts[1] }).should.be.rejectedWith(EVMThrow);
    });

    it('should allow receiver to spend ERC1155 payment by revealing a secret even after locktime', async function () {
        const lockTime = await currentEvmTime() + 1000;
        const tokenId = 1; // Token ID used in Erc1155Token contract
        const amountToSend = 2; // Amount of tokens to send

        const data = web3.eth.abi.encodeParameters(
            ['bytes32', 'address', 'address', 'bytes20', 'uint64'],
            [id, accounts[1], this.erc1155token.address, secretHash, lockTime]
        );
        // Call safeTransferFrom directly to transfer the tokens to the EtomicSwap contract
        await this.erc1155token.safeTransferFrom(accounts[0], this.swap.address, tokenId, amountToSend, data).should.be.fulfilled;

        await advanceTimeAndMine(1000);

        // Successful spend by receiver with valid secret even after locktime
        await this.swap.receiverSpendErc1155(id, amountToSend, secretHex, this.erc1155token.address, tokenId, accounts[0], { from: accounts[1] }).should.be.fulfilled;

        // Check the state of the payment
        const payment = await this.swap.payments(id);
        assert.equal(payment[2].valueOf(), RECEIVER_SPENT);

        // Check the balance of the token - should be transferred to the receiver (accounts[1])
        let tokenBalance = await this.erc1155token.balanceOf(accounts[1], tokenId);
        assert.equal(tokenBalance.toNumber(), amountToSend);

        // Check that the swap contract no longer holds the tokens
        tokenBalance = await this.erc1155token.balanceOf(this.swap.address, tokenId);
        assert.equal(tokenBalance.toNumber(), 0);

        // Attempting to spend again - should fail
        await this.swap.receiverSpendErc1155(id, amountToSend, secretHex, this.erc1155token.address, tokenId, accounts[0], { from: accounts[1] }).should.be.rejectedWith(EVMThrow);
    });
        **/
});
