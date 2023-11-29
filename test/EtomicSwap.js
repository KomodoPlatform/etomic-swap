const Swap = artifacts.require('EtomicSwap');
const Token = artifacts.require('Token');
const Erc721Token = artifacts.require('Erc721Token');
const Erc1155Token = artifacts.require('Erc1155Token');
const crypto = require('crypto');
const RIPEMD160 = require('ripemd160');

const EVMThrow = 'VM Exception while processing transaction';

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
    await web3.currentProvider.request({
        method: 'evm_increaseTime',
        params: [increaseAmount],
    });
    await web3.currentProvider.request({ method: 'evm_mine' });
}

async function currentEvmTime() {
    const block = await web3.eth.getBlock("latest");
    return block.timestamp;
}

const id = '0x' + crypto.randomBytes(32).toString('hex');
const [PAYMENT_UNINITIALIZED, PAYMENT_SENT, RECEIVER_SPENT, SENDER_REFUNDED] = [0, 1, 2, 3];

const secret = crypto.randomBytes(32);
const secretHash = '0x' + new RIPEMD160().update(crypto.createHash('sha256').update(secret).digest()).digest('hex');
const secretHex = '0x' + secret.toString('hex');

const zeroAddr = '0x0000000000000000000000000000000000000000';

contract('EtomicSwap', function(accounts) {

    beforeEach(async function () {
        this.swap = await Swap.new();
        this.token = await Token.new();
        this.erc721token = await Erc721Token.new("MyNFT", "MNFT");
        this.erc1155token = await Erc1155Token.new("uri");
        await this.token.transfer(accounts[1], web3.utils.toWei('100'));
    });

    it('should create contract with uninitialized payments', async function () {
        const payment = await this.swap.payments(id);
        assert.equal(payment[2].valueOf(), PAYMENT_UNINITIALIZED);
    });

    it('should have correct ERC1155 token balance', async function() {
        const amount = 3;
        const tokenId = 1;
        const balance = await this.erc1155token.balanceOf(accounts[0], tokenId);
        assert.equal(balance.toNumber(), amount, "Balance of ERC1155 tokens in EtomicSwap contract is incorrect");
    });

    it('should allow to send ETH payment', async function () {
        const lockTime = await currentEvmTime() + 1000;
        const params = [
            id,
            accounts[1],
            secretHash,
            lockTime
        ];
        await this.swap.ethPayment(...params, { value: web3.utils.toWei('1') }).should.be.fulfilled;

        const payment = await this.swap.payments(id);

        // locktime
        assert.equal(payment[1].valueOf(), lockTime);
        // status
        assert.equal(payment[2].valueOf(), PAYMENT_SENT);

        // should not allow to send again
        await this.swap.ethPayment(...params, { value: web3.utils.toWei('1') }).should.be.rejectedWith(EVMThrow);
    });

    it('should allow to send ERC20 payment', async function () {
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

        //check contract token balance
        const balance = await this.token.balanceOf(this.swap.address);
        assert.equal(balance.toString(), web3.utils.toWei('1'));

        const payment = await this.swap.payments(id);

        // locktime
        assert.equal(payment[1].valueOf(), lockTime);
        // status
        assert.equal(payment[2].valueOf(), PAYMENT_SENT);

        // should not allow to deposit again
        await this.swap.erc20Payment(...params).should.be.rejectedWith(EVMThrow);
    });

    it('should allow to send ERC721 payment', async function () {
        const lockTime = await currentEvmTime() + 1000;
        const tokenId = 1; // Assuming token ID 1 is minted to accounts[0] in Erc721Token contract

        const data = web3.eth.abi.encodeParameters(
            ['bytes32', 'address', 'address', 'bytes20', 'uint64'],
            [id, accounts[1], this.erc721token.address, secretHash, lockTime]
        );
        // Call safeTransferFrom directly to transfer the token to the EtomicSwap contract
        await this.erc721token.safeTransferFrom(accounts[0], this.swap.address, tokenId, data).should.be.fulfilled;

        // Check the payment lockTime and state
        const payment = await this.swap.payments(id);
        assert.equal(payment[1].valueOf(), lockTime);
        assert.equal(payment[2].valueOf(), PAYMENT_SENT);

        // Check the ownership of the token
        const tokenOwner = await this.erc721token.ownerOf(tokenId);
        assert.equal(tokenOwner, this.swap.address);

        // should not allow to send again
        await this.erc721token.safeTransferFrom(accounts[0], this.swap.address, tokenId, data).should.be.rejectedWith(EVMThrow);
    });

    it('should allow to send ERC1155 payment', async function () {
        const lockTime = await currentEvmTime() + 1000;
        const tokenId = 1; // Token ID used in Erc1155Token contract
        const amountToSend = 2; // Amount of tokens to send

        const data = web3.eth.abi.encodeParameters(
            ['bytes32', 'address', 'address', 'bytes20', 'uint64'],
            [id, accounts[1], this.erc1155token.address, secretHash, lockTime]
        );
        // Call safeTransferFrom directly to transfer the tokens to the EtomicSwap contract
        await this.erc1155token.safeTransferFrom(accounts[0], this.swap.address, tokenId, amountToSend, data).should.be.fulfilled;

        // Check the payment lockTime and state
        const payment = await this.swap.payments(id);
        assert.equal(payment[1].valueOf(), lockTime);
        assert.equal(payment[2].valueOf(), PAYMENT_SENT);

        // Check the balance of the token in the swap contract
        const tokenBalance = await this.erc1155token.balanceOf(this.swap.address, tokenId);
        assert.equal(tokenBalance.toNumber(), amountToSend);

        // should not allow to send same params again
        await this.erc1155token.safeTransferFrom(accounts[0], this.swap.address, tokenId, amountToSend, data).should.be.rejectedWith(EVMThrow);

        // sender should be capable to send more tokens, if they have it
        const id1 = '0x' + crypto.randomBytes(32).toString('hex');
        const data1 = web3.eth.abi.encodeParameters(
            ['bytes32', 'address', 'address', 'bytes20', 'uint64'],
            [id1, accounts[1], this.erc1155token.address, secretHash, lockTime]
        );
        await this.erc1155token.safeTransferFrom(accounts[0], this.swap.address, tokenId, 1, data1).should.be.fulfilled;

        // Check sending more tokens than the sender owns - should fail
        const id2 = '0x' + crypto.randomBytes(32).toString('hex');
        const data2 = web3.eth.abi.encodeParameters(
            ['bytes32', 'address', 'address', 'bytes20', 'uint64'],
            [id2, accounts[1], this.erc1155token.address, secretHash, lockTime]
        );
        await this.erc1155token.safeTransferFrom(accounts[0], this.swap.address, tokenId, 1, data2).should.be.rejectedWith(EVMThrow);
    });

    it('should allow sender to refund ETH payment after locktime', async function () {
        const lockTime = await currentEvmTime() + 1000;
        const params = [
            id,
            accounts[1],
            secretHash,
            lockTime
        ];

        // not allow to refund if payment was not sent
        await this.swap.senderRefund(id, web3.utils.toWei('1'), secretHash, zeroAddr, accounts[1]).should.be.rejectedWith(EVMThrow);

        await this.swap.ethPayment(...params, { value: web3.utils.toWei('1') }).should.be.fulfilled;

        // not allow to refund before locktime
        await this.swap.senderRefund(id, web3.utils.toWei('1'), secretHash, zeroAddr, accounts[1]).should.be.rejectedWith(EVMThrow);

        await advanceTimeAndMine(1000);

        // not allow to call refund from non-sender address
        await this.swap.senderRefund(id, web3.utils.toWei('1'), secretHash, zeroAddr, accounts[1], { from: accounts[1] }).should.be.rejectedWith(EVMThrow);

        // not allow to refund invalid amount
        await this.swap.senderRefund(id, web3.utils.toWei('2'), secretHash, zeroAddr, accounts[1]).should.be.rejectedWith(EVMThrow);

        // success refund
        const balanceBefore = web3.utils.toBN(await web3.eth.getBalance(accounts[0]));
        const gasPrice = web3.utils.toWei('100', 'gwei');

        const tx = await this.swap.senderRefund(id, web3.utils.toWei('1'), secretHash, zeroAddr, accounts[1], { gasPrice }).should.be.fulfilled;
        const balanceAfter = web3.utils.toBN(await web3.eth.getBalance(accounts[0]));

        const txFee = web3.utils.toBN(gasPrice).mul(web3.utils.toBN(tx.receipt.gasUsed));
        // check sender balance
        assert.equal(balanceAfter.sub(balanceBefore).add(txFee).toString(), web3.utils.toWei('1'));

        const payment = await this.swap.payments(id);
        assert.equal(payment[2].valueOf(), SENDER_REFUNDED);

        // not allow to refund again
        await this.swap.senderRefund(id, web3.utils.toWei('1'), secretHash, zeroAddr, accounts[1]).should.be.rejectedWith(EVMThrow);
    });

    it('should allow sender to refund ERC20 payment after locktime', async function () {
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

        // not allow to refund if payment was not sent
        await this.swap.senderRefund(id, web3.utils.toWei('1'), secretHash, this.token.address, accounts[1]).should.be.rejectedWith(EVMThrow);

        // not allow to refund before locktime
        await this.swap.senderRefund(id, web3.utils.toWei('1'), secretHash, this.token.address, accounts[1]).should.be.rejectedWith(EVMThrow);

        await advanceTimeAndMine(1000);

        // not allow to call refund from non-sender address
        await this.swap.senderRefund(id, web3.utils.toWei('1'), secretHash, this.token.address, accounts[1], { from: accounts[1] }).should.be.rejectedWith(EVMThrow);

        // not allow to refund invalid amount
        await this.swap.senderRefund(id, web3.utils.toWei('2'), secretHash, this.token.address, accounts[1]).should.be.rejectedWith(EVMThrow);

        // success refund
        const balanceBefore = web3.utils.toBN(await this.token.balanceOf(accounts[0]));

        await this.swap.senderRefund(id, web3.utils.toWei('1'), secretHash, this.token.address, accounts[1]).should.be.fulfilled;

        const balanceAfter = web3.utils.toBN(await this.token.balanceOf(accounts[0]));

        // check sender balance
        assert.equal(balanceAfter.sub(balanceBefore).toString(), web3.utils.toWei('1'));

        const payment = await this.swap.payments(id);
        assert.equal(payment[2].valueOf(), SENDER_REFUNDED);

        // not allow to refund again
        await this.swap.senderRefund(id, web3.utils.toWei('1'), secretHash, this.token.address, accounts[1]).should.be.rejectedWith(EVMThrow);
    });

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
        await this.swap.receiverSpend(id, web3.utils.toWei('1'), id, zeroAddr, accounts[0], { from: accounts[1] }).should.be.rejectedWith(EVMThrow);
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
        await this.swap.receiverSpend(id, web3.utils.toWei('1'), id, this.token.address, accounts[0], { from: accounts[1] }).should.be.rejectedWith(EVMThrow);
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
        await this.swap.receiverSpendErc721(id, zeroAddr, this.erc721token.address, tokenId, accounts[0], { from: accounts[1] }).should.be.rejectedWith(EVMThrow);

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
        await this.swap.receiverSpendErc1155(id, amountToSend, zeroAddr, this.erc1155token.address, tokenId, accounts[0], { from: accounts[1] }).should.be.rejectedWith(EVMThrow);

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
});
