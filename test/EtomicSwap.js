const Swap = artifacts.require('EtomicSwap');
const Token = artifacts.require('Token');
const crypto = require('crypto');
const RIPEMD160 = require('ripemd160');

const EVMThrow = 'VM Exception while processing transaction';

require('chai')
    .use(require('chai-as-promised'))
    .should();

function increaseTime (increaseAmount) {
    return new Promise((resolve, reject) => {
        web3.currentProvider.send({
                jsonrpc: '2.0',
                method: 'evm_increaseTime',
                id: Date.now(),
                params: [increaseAmount]
        }, (err, res) => {
            return err ? reject(err) : resolve(res);
        });
    });
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

const watcherReward = web3.utils.toBN(100000);

contract('EtomicSwap', function(accounts) {

    beforeEach(async function () {
        this.swap = await Swap.new();
        this.token = await Token.new();
        await this.token.transfer(accounts[1], web3.utils.toWei('100'));
    });

    it('should create contract with uninitialized payments', async function () {
        const payment = await this.swap.payments(id);
        assert.equal(payment[2].valueOf(), PAYMENT_UNINITIALIZED);
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

    it('should allow sender without watcher support to refund ETH payment after locktime', async function () {
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

        await increaseTime(1000);

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

    it('should allow sender with regular watcher reward to refund ETH payment after locktime', async function () {
        const lockTime = await currentEvmTime() + 1000;
        const params = [
            id,
            accounts[1],
            secretHash,
            lockTime,
            watcherReward,
            false
        ];
        let amount = web3.utils.toWei(web3.utils.toBN(1)).add(watcherReward);
        
        //not allow to refund if payment was not sent
        await this.swap.senderRefundReward(id, amount, secretHash, zeroAddr, accounts[0], accounts[1], watcherReward, false).should.be.rejectedWith(EVMThrow);

        await this.swap.ethPaymentReward(...params, { value: amount }).should.be.fulfilled;

        // not allow to refund before locktime
        await this.swap.senderRefundReward(id, amount, secretHash, zeroAddr, accounts[0], accounts[1], watcherReward, false).should.be.rejectedWith(EVMThrow);

        await increaseTime(1000);

        // not allow to refund invalid amount
        await this.swap.senderRefundReward(id, web3.utils.toWei('5'), secretHash, zeroAddr, accounts[0], accounts[1], watcherReward, false).should.be.rejectedWith(EVMThrow);

        // not allow to refund invalid watcher reward amount
        await this.swap.senderRefundReward(id, amount, secretHash, zeroAddr, accounts[0], accounts[1], web3.utils.toWei('5'), false).should.be.rejectedWith(EVMThrow);

        // success refund
        const takerBalanceBefore = web3.utils.toBN(await web3.eth.getBalance(accounts[0]));

        const gasPrice = web3.utils.toWei('100', 'gwei');
        const tx = await this.swap.senderRefundReward(id, amount, secretHash, zeroAddr, accounts[0], accounts[1], watcherReward, false, { gasPrice }).should.be.fulfilled;
        
        const takerBalanceAfter = web3.utils.toBN(await web3.eth.getBalance(accounts[0]));

        const txFee = web3.utils.toBN(gasPrice).mul(web3.utils.toBN(tx.receipt.gasUsed));
        // check sender balance
        assert.equal(takerBalanceAfter.sub(takerBalanceBefore).add(txFee).toString(), web3.utils.toWei(web3.utils.toBN(1)).add(watcherReward));

        const payment = await this.swap.payments(id);
        assert.equal(payment[2].valueOf(), SENDER_REFUNDED);

        // not allow to refund again
        await this.swap.senderRefundReward(id, amount, secretHash, zeroAddr, accounts[0], accounts[1], watcherReward, false).should.be.rejectedWith(EVMThrow);
    });

    it('should allow sender with refund-only watcher reward to refund ETH payment after locktime', async function () {
        const lockTime = await currentEvmTime() + 1000;
        const params = [
            id,
            accounts[1],
            secretHash,
            lockTime,
            watcherReward,
            true
        ];
        let amount = web3.utils.toWei(web3.utils.toBN(1)).add(watcherReward);
        
        //not allow to refund if payment was not sent
        await this.swap.senderRefundReward(id, amount, secretHash, zeroAddr, accounts[0], accounts[1], watcherReward, true).should.be.rejectedWith(EVMThrow);

        await this.swap.ethPaymentReward(...params, { value: amount }).should.be.fulfilled;

        // not allow to refund before locktime
        await this.swap.senderRefundReward(id, amount, secretHash, zeroAddr, accounts[0], accounts[1], watcherReward, true).should.be.rejectedWith(EVMThrow);

        await increaseTime(1000);

        // not allow to refund invalid amount
        await this.swap.senderRefundReward(id, web3.utils.toWei('5'), secretHash, zeroAddr, accounts[0], accounts[1], watcherReward, true).should.be.rejectedWith(EVMThrow);

        // not allow to refund invalid watcher reward amount
        await this.swap.senderRefundReward(id, amount, secretHash, zeroAddr, accounts[0], accounts[1], web3.utils.toWei('5'), true).should.be.rejectedWith(EVMThrow);

        const takerBalanceBefore = web3.utils.toBN(await web3.eth.getBalance(accounts[0]));
        const gasPrice = web3.utils.toWei('100', 'gwei');

        // not allow to refund with regular watcher reward parameter
        await this.swap.senderRefundReward(id, amount, secretHash, zeroAddr, accounts[0], accounts[1], watcherReward, false, { gasPrice }).should.be.rejectedWith(EVMThrow);

        // success refund
        const tx = await this.swap.senderRefundReward(id, amount, secretHash, zeroAddr, accounts[0], accounts[1], watcherReward, true, { gasPrice }).should.be.fulfilled;
        const takerBalanceAfter = web3.utils.toBN(await web3.eth.getBalance(accounts[0]));

        const txFee = web3.utils.toBN(gasPrice).mul(web3.utils.toBN(tx.receipt.gasUsed));
        // check sender balance
        assert.equal(takerBalanceAfter.sub(takerBalanceBefore).toString(), web3.utils.toWei(web3.utils.toBN(1)).sub(txFee).add(watcherReward).toString());

        const payment = await this.swap.payments(id);
        assert.equal(payment[2].valueOf(), SENDER_REFUNDED);

        // not allow to refund again
        await this.swap.senderRefundReward(id, amount, secretHash, zeroAddr, accounts[0], accounts[1], watcherReward, true).should.be.rejectedWith(EVMThrow);
    });

    it('should allow sender without watcher support to refund ERC20 payment after locktime', async function () {
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

        await increaseTime(1000);

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

    it('should allow sender with regular watcher reward to refund ERC20 payment after locktime', async function () {
        const lockTime = await currentEvmTime() + 1000;
        let amount = web3.utils.toWei(web3.utils.toBN(1)).add(watcherReward);
        const params = [
            id,
            amount,
            this.token.address,
            accounts[1],
            secretHash,
            lockTime,
            watcherReward,
            false
        ];

        await this.token.approve(this.swap.address, amount);
        await this.swap.erc20PaymentReward(...params).should.be.fulfilled;

        // not allow to refund if payment was not sent
        await this.swap.senderRefundReward(id, amount, secretHash, this.token.address, accounts[0], accounts[1], watcherReward, false).should.be.rejectedWith(EVMThrow);

        // not allow to refund before locktime
        await this.swap.senderRefundReward(id, amount, secretHash, this.token.address, accounts[0], accounts[1], watcherReward, false).should.be.rejectedWith(EVMThrow);

        await increaseTime(1000);

        // not allow to refund invalid amount
        await this.swap.senderRefundReward(id, web3.utils.toWei('2'), secretHash, this.token.address, accounts[0], accounts[1], watcherReward, false).should.be.rejectedWith(EVMThrow);

        // not allow to refund invalid watcherReward amount
        await this.swap.senderRefundReward(id, amount, secretHash, this.token.address, accounts[0], accounts[1], amount, false).should.be.rejectedWith(EVMThrow);

        // success refund
        const takerERC20BalanceBefore = web3.utils.toBN(await this.token.balanceOf(accounts[0]));
        const takerETHBalanceBefore = web3.utils.toBN(await web3.eth.getBalance(accounts[0]));

        const gasPrice = web3.utils.toWei('100', 'gwei');
        let tx = await this.swap.senderRefundReward(id, amount, secretHash, this.token.address, accounts[0], accounts[1], watcherReward, false, { gasPrice }).should.be.fulfilled;
        const txFee = web3.utils.toBN(gasPrice).mul(web3.utils.toBN(tx.receipt.gasUsed));

        const takerERC20BalanceAfter = web3.utils.toBN(await this.token.balanceOf(accounts[0]));
        const takerETHBalanceAfter = web3.utils.toBN(await web3.eth.getBalance(accounts[0]));

        // check sender balance
        assert.equal(takerERC20BalanceAfter.sub(takerERC20BalanceBefore).toString(), web3.utils.toWei(web3.utils.toBN(1)).add(watcherReward));
        assert.equal(takerETHBalanceAfter.add(txFee).toString(), takerETHBalanceBefore);

        const payment = await this.swap.payments(id);
        assert.equal(payment[2].valueOf(), SENDER_REFUNDED);

        // not allow to refund again
        await this.swap.senderRefundReward(id, web3.utils.toWei('1'), secretHash, this.token.address, accounts[0], accounts[1], watcherReward, false).should.be.rejectedWith(EVMThrow);
    });

    it('should allow sender with refund-only watcher reward to refund ERC20 payment after locktime', async function () {
        const lockTime = await currentEvmTime() + 1000;
        let amount = web3.utils.toWei(web3.utils.toBN(1)).add(watcherReward);
        const params = [
            id,
            amount,
            this.token.address,
            accounts[1],
            secretHash,
            lockTime,
            watcherReward,
            true
        ];

        await this.token.approve(this.swap.address, amount);
        await this.swap.erc20PaymentReward(...params).should.be.fulfilled;

        // not allow to refund if payment was not sent
        await this.swap.senderRefundReward(id, amount, secretHash, this.token.address, accounts[0], accounts[1], watcherReward, true).should.be.rejectedWith(EVMThrow);

        // not allow to refund before locktime
        await this.swap.senderRefundReward(id, amount, secretHash, this.token.address, accounts[0], accounts[1], watcherReward, true).should.be.rejectedWith(EVMThrow);

        await increaseTime(1000);

        // not allow to refund invalid amount
        await this.swap.senderRefundReward(id, web3.utils.toWei('2'), secretHash, this.token.address, accounts[0], accounts[1], watcherReward, true).should.be.rejectedWith(EVMThrow);

        // not allow to refund invalid watcherReward amount
        await this.swap.senderRefundReward(id, amount, secretHash, this.token.address, accounts[0], accounts[1], amount, true).should.be.rejectedWith(EVMThrow);

        
        const takerERC20BalanceBefore = web3.utils.toBN(await this.token.balanceOf(accounts[0]));
        const gasPrice = web3.utils.toWei('100', 'gwei');

        // not allow to refund with regular watcher reward parameter
        await this.swap.senderRefundReward(id, amount, secretHash, this.token.address, accounts[0], accounts[1], watcherReward, false, { gasPrice }).should.be.rejectedWith(EVMThrow);

        // success refund
        let tx = await this.swap.senderRefundReward(id, amount, secretHash, this.token.address, accounts[0], accounts[1], watcherReward, true, { gasPrice }).should.be.fulfilled;
        const txFee = web3.utils.toBN(gasPrice).mul(web3.utils.toBN(tx.receipt.gasUsed));

        const takerERC20BalanceAfter = web3.utils.toBN(await this.token.balanceOf(accounts[0]));

        // check sender balance
        assert.equal(takerERC20BalanceAfter.sub(takerERC20BalanceBefore).toString(), web3.utils.toWei(web3.utils.toBN(1)).add(watcherReward));

        const payment = await this.swap.payments(id);
        assert.equal(payment[2].valueOf(), SENDER_REFUNDED);

        // not allow to refund again
        await this.swap.senderRefundReward(id, web3.utils.toWei('1'), secretHash, this.token.address, accounts[0], accounts[1], watcherReward, true).should.be.rejectedWith(EVMThrow);
    });

    it('should allow receiver without watcher support to spend ETH payment by revealing a secret', async function () {
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

    it('should allow receiver with regular watcher reward to spend ETH payment by revealing a secret', async function () {
        const lockTime = await currentEvmTime() + 1000;
        const params = [
            id,
            accounts[1],
            secretHash,
            lockTime,
            watcherReward,
            false
        ];
        let amount = web3.utils.toWei(web3.utils.toBN(1)).add(watcherReward);

        // should not allow to spend uninitialized payment
        await this.swap.receiverSpendReward(id, web3.utils.toWei('1'), secretHex, zeroAddr, accounts[0], accounts[1], watcherReward, false, { from: accounts[1] }).should.be.rejectedWith(EVMThrow);

        await this.swap.ethPaymentReward(...params, { value: amount }).should.be.fulfilled;

        // should not allow to spend with invalid secret
        await this.swap.receiverSpendReward(id, amount, id, zeroAddr, accounts[0], accounts[1], watcherReward, false, { from: accounts[1] }).should.be.rejectedWith(EVMThrow);
        
        // should not allow to spend invalid amount
        await this.swap.receiverSpendReward(id, web3.utils.toWei('5'), secretHex, zeroAddr, accounts[0], accounts[1], watcherReward, false, { from: accounts[1] }).should.be.rejectedWith(EVMThrow);

        // success spend
        const takerBalanceBefore = web3.utils.toBN(await web3.eth.getBalance(accounts[1]));
        const gasPrice = web3.utils.toWei('100', 'gwei');

        const tx = await this.swap.receiverSpendReward(id, amount, secretHex, zeroAddr, accounts[0], accounts[1], watcherReward, false, { from: accounts[1], gasPrice }).should.be.fulfilled;
        
        const txFee = web3.utils.toBN(gasPrice).mul(web3.utils.toBN(tx.receipt.gasUsed));

        const takerBalanceAfter = web3.utils.toBN(await web3.eth.getBalance(accounts[1]));

        // check receiver balance
        assert.equal(takerBalanceAfter.sub(takerBalanceBefore).add(txFee).toString(), web3.utils.toWei(web3.utils.toBN(1)).add(watcherReward));

        const payment = await this.swap.payments(id);

        // status
        assert.equal(payment[2].valueOf(), RECEIVER_SPENT);

        // should not allow to spend again
        await this.swap.receiverSpendReward(id, web3.utils.toWei('1'), secretHex, zeroAddr, accounts[0], accounts[1], watcherReward, false, { from: accounts[1], gasPrice }).should.be.rejectedWith(EVMThrow);
    });

    it('should allow receiver with refund-only watcher reward to spend ETH payment by revealing a secret', async function () {
        const lockTime = await currentEvmTime() + 1000;
        const params = [
            id,
            accounts[1],
            secretHash,
            lockTime,
            watcherReward,
            true
        ];
        let amount = web3.utils.toWei(web3.utils.toBN(1)).add(watcherReward);

        // should not allow to spend uninitialized payment
        await this.swap.receiverSpendReward(id, web3.utils.toWei('1'), secretHex, zeroAddr, accounts[0], accounts[1], watcherReward, true, { from: accounts[1] }).should.be.rejectedWith(EVMThrow);

        await this.swap.ethPaymentReward(...params, { value: amount }).should.be.fulfilled;

        // should not allow to spend with invalid secret
        await this.swap.receiverSpendReward(id, amount, id, zeroAddr, accounts[0], accounts[1], watcherReward, true, { from: accounts[1] }).should.be.rejectedWith(EVMThrow);
        
        // should not allow to spend invalid amount
        await this.swap.receiverSpendReward(id, web3.utils.toWei('5'), secretHex, zeroAddr, accounts[0], accounts[1], watcherReward, true, { from: accounts[1] }).should.be.rejectedWith(EVMThrow);

        const senderBalanceBefore = web3.utils.toBN(await web3.eth.getBalance(accounts[0]));
        const receiverBalanceBefore = web3.utils.toBN(await web3.eth.getBalance(accounts[1]));
        const gasPrice = web3.utils.toWei('100', 'gwei');

        // now allow to spend with regular watcher reward parameter
        await this.swap.receiverSpendReward(id, amount, secretHex, zeroAddr, accounts[0], accounts[1], watcherReward, false, { from: accounts[1], gasPrice }).should.be.rejectedWith(EVMThrow);

        // success spend
        const tx = await this.swap.receiverSpendReward(id, amount, secretHex, zeroAddr, accounts[0], accounts[1], watcherReward, true, { from: accounts[1], gasPrice }).should.be.fulfilled;
        
        const txFee = web3.utils.toBN(gasPrice).mul(web3.utils.toBN(tx.receipt.gasUsed));
        const senderBalanceAfter = web3.utils.toBN(await web3.eth.getBalance(accounts[0]));
        const receiverBalanceAfter = web3.utils.toBN(await web3.eth.getBalance(accounts[1]));

        // check receiver balance
        assert.equal(receiverBalanceAfter.sub(receiverBalanceBefore).toString(), web3.utils.toWei(web3.utils.toBN(1)).sub(txFee).toString());
        assert.equal(senderBalanceAfter.sub(senderBalanceBefore).toString(), watcherReward);

        const payment = await this.swap.payments(id);

        // status
        assert.equal(payment[2].valueOf(), RECEIVER_SPENT);

        // should not allow to spend again
        await this.swap.receiverSpendReward(id, web3.utils.toWei('1'), secretHex, zeroAddr, accounts[0], accounts[1], watcherReward, true, { from: accounts[1], gasPrice }).should.be.rejectedWith(EVMThrow);
    });

    it('should allow receiver without watcher support to spend ERC20 payment by revealing a secret', async function () {
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

    it('should allow receiver with regular watcher reward to spend ERC20 payment by revealing a secret', async function () {
        const lockTime = await currentEvmTime() + 1000;
        let amount = web3.utils.toWei(web3.utils.toBN(1)).add(watcherReward);
        const params = [
            id,
            amount,
            this.token.address,
            accounts[1],
            secretHash,
            lockTime,
            watcherReward,
            false
        ];

        // should not allow to spend uninitialized payment
        await this.swap.receiverSpendReward(id, amount, secretHex, this.token.address, accounts[0], accounts[1], watcherReward, false, { from: accounts[1] }).should.be.rejectedWith(EVMThrow);

        await this.token.approve(this.swap.address, amount);
        await this.swap.erc20PaymentReward(...params).should.be.fulfilled;

        // should not allow to spend with invalid secret
        await this.swap.receiverSpendReward(id, amount, id, this.token.address, accounts[0], accounts[1], watcherReward, false, { from: accounts[1] }).should.be.rejectedWith(EVMThrow);
        
        // should not allow to spend invalid amount
        await this.swap.receiverSpendReward(id, web3.utils.toWei('5'), secretHex, this.token.address, accounts[0], accounts[1], watcherReward, false, { from: accounts[1] }).should.be.rejectedWith(EVMThrow);

        // should not allow to spend invalid watcher reward amount
        await this.swap.receiverSpendReward(id, amount, secretHex, this.token.address, accounts[0], accounts[1], amount, false, { from: accounts[1] }).should.be.rejectedWith(EVMThrow);

        // success spend
        const takerERC20BalanceBefore = web3.utils.toBN(await this.token.balanceOf(accounts[1]));
        const takerETHBalanceBefore = web3.utils.toBN(await web3.eth.getBalance(accounts[1]));

        const gasPrice = web3.utils.toWei('100', 'gwei');
        let tx = await this.swap.receiverSpendReward(id, amount, secretHex, this.token.address, accounts[0], accounts[1], watcherReward, false, { from: accounts[1], gasPrice }).should.be.fulfilled;
        const txFee = web3.utils.toBN(gasPrice).mul(web3.utils.toBN(tx.receipt.gasUsed));
        
        const takerERC20BalanceAfter = web3.utils.toBN(await this.token.balanceOf(accounts[1]));
        const takerETHBalanceAfter = web3.utils.toBN(await web3.eth.getBalance(accounts[1]));

        // check receiver balance
        assert.equal(takerERC20BalanceAfter.sub(takerERC20BalanceBefore).toString(), web3.utils.toWei(web3.utils.toBN(1)).add(watcherReward));
        assert.equal(takerETHBalanceAfter.add(txFee).toString(), takerETHBalanceBefore);

        const payment = await this.swap.payments(id);

        // status
        assert.equal(payment[2].valueOf(), RECEIVER_SPENT);

        // should not allow to spend again
        await this.swap.receiverSpendReward(id, web3.utils.toWei('1'), secretHex, this.token.address, accounts[0], accounts[1], watcherReward, false, { from: accounts[1], gasPrice }).should.be.rejectedWith(EVMThrow);
    });

    it('should allow receiver with refund-only watcher reward to spend ERC20 payment by revealing a secret', async function () {
        const lockTime = await currentEvmTime() + 1000;
        let amount = web3.utils.toWei(web3.utils.toBN(1)).add(watcherReward);
        const params = [
            id,
            amount,
            this.token.address,
            accounts[1],
            secretHash,
            lockTime,
            watcherReward,
            true
        ];

        // should not allow to spend uninitialized payment
        await this.swap.receiverSpendReward(id, amount, secretHex, this.token.address, accounts[0], accounts[1], watcherReward, true, { from: accounts[1] }).should.be.rejectedWith(EVMThrow);

        await this.token.approve(this.swap.address, amount);
        await this.swap.erc20PaymentReward(...params).should.be.fulfilled;

        // should not allow to spend with invalid secret
        await this.swap.receiverSpendReward(id, amount, id, this.token.address, accounts[0], accounts[1], watcherReward, true, { from: accounts[1] }).should.be.rejectedWith(EVMThrow);
        
        // should not allow to spend invalid amount
        await this.swap.receiverSpendReward(id, web3.utils.toWei('5'), secretHex, this.token.address, accounts[0], accounts[1], watcherReward, true, { from: accounts[1] }).should.be.rejectedWith(EVMThrow);

        // should not allow to spend invalid watcher reward amount
        await this.swap.receiverSpendReward(id, amount, secretHex, this.token.address, accounts[0], accounts[1], amount, true, { from: accounts[1] }).should.be.rejectedWith(EVMThrow);

        const senderERC20BalanceBefore = web3.utils.toBN(await this.token.balanceOf(accounts[0]));
        const receiverERC20BalanceBefore = web3.utils.toBN(await this.token.balanceOf(accounts[1]));
        const gasPrice = web3.utils.toWei('100', 'gwei');

        // now allow to spend with regular watcher reward parameter
        await this.swap.receiverSpendReward(id, amount, secretHex, this.token.address, accounts[0], accounts[1], watcherReward, false, { from: accounts[1], gasPrice }).should.be.rejectedWith(EVMThrow);

        // success spend
        let tx = await this.swap.receiverSpendReward(id, amount, secretHex, this.token.address, accounts[0], accounts[1], watcherReward, true, { from: accounts[1], gasPrice }).should.be.fulfilled;
        const txFee = web3.utils.toBN(gasPrice).mul(web3.utils.toBN(tx.receipt.gasUsed));
        
        const senderERC20BalanceAfter = web3.utils.toBN(await this.token.balanceOf(accounts[0]));
        const receiverERC20BalanceAfter = web3.utils.toBN(await this.token.balanceOf(accounts[1]));

        // check receiver balance
        assert.equal(receiverERC20BalanceAfter.sub(receiverERC20BalanceBefore).toString(), web3.utils.toWei(web3.utils.toBN(1)));
        assert.equal(senderERC20BalanceAfter.sub(senderERC20BalanceBefore).toString(), watcherReward);

        const payment = await this.swap.payments(id);

        // status
        assert.equal(payment[2].valueOf(), RECEIVER_SPENT);

        // should not allow to spend again
        await this.swap.receiverSpendReward(id, web3.utils.toWei('1'), secretHex, this.token.address, accounts[0], accounts[1], watcherReward, false, { from: accounts[1], gasPrice }).should.be.rejectedWith(EVMThrow);
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

        await increaseTime(1000);

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

        await increaseTime(1000);

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

    it('should allow a watcher to refund ETH payment with regular reward on behalf of the sender after locktime', async function () {
        const lockTime = await currentEvmTime() + 1000;
        const params = [
            id,
            accounts[1],
            secretHash,
            lockTime,
            watcherReward,
            false
        ];
        let amount = web3.utils.toWei(web3.utils.toBN(1)).add(watcherReward);

        // not allow to refund if payment was not sent
        await this.swap.senderRefundReward(id, amount, secretHash, zeroAddr, accounts[0], accounts[1], watcherReward, false, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);

        await this.swap.ethPaymentReward(...params, { value: amount }).should.be.fulfilled;

        // not allow to refund before locktime
        await this.swap.senderRefundReward(id, amount, secretHash, zeroAddr, accounts[0], accounts[1], watcherReward, false, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);

        await increaseTime(1000);

        // not allow to refund invalid amount
        await this.swap.senderRefundReward(id, web3.utils.toWei('5'), secretHash, zeroAddr, accounts[0], accounts[1], watcherReward, false, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);

        // not allow to refund invalid watcher reward amount
        await this.swap.senderRefundReward(id, amount, secretHash, zeroAddr, accounts[0], accounts[1], web3.utils.toWei('5'), false, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);

        // not allow to refund with wrong sender address
        await this.swap.senderRefundReward(id, amount, secretHash, zeroAddr, accounts[2], accounts[1], watcherReward, false, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);

        // not allow to refund with wrong receiver address
        await this.swap.senderRefundReward(id, amount, secretHash, zeroAddr, accounts[0], accounts[2], watcherReward, false, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);

        // success refund
        const watcherBalanceBefore = web3.utils.toBN(await web3.eth.getBalance(accounts[2]));
        const takerBalanceBefore = web3.utils.toBN(await web3.eth.getBalance(accounts[0]));

        const gasPrice = web3.utils.toWei('100', 'gwei');
        const tx = await this.swap.senderRefundReward(id, amount, secretHash, zeroAddr, accounts[0], accounts[1], watcherReward, false, { from: accounts[2], gasPrice }).should.be.fulfilled;
        const txFee = web3.utils.toBN(gasPrice).mul(web3.utils.toBN(tx.receipt.gasUsed));

        const watcherBalanceAfter = web3.utils.toBN(await web3.eth.getBalance(accounts[2]));
        const takerBalanceAfter = web3.utils.toBN(await web3.eth.getBalance(accounts[0]));

        // check watcher balance
        assert.equal(watcherBalanceAfter.sub(watcherBalanceBefore).toString(), watcherReward.sub(txFee));
        assert.equal(takerBalanceAfter.sub(takerBalanceBefore).toString(), web3.utils.toWei('1'));

        const payment = await this.swap.payments(id);
        assert.equal(payment[2].valueOf(), SENDER_REFUNDED);

        // not allow to refund again
        await this.swap.senderRefundReward(id, amount, secretHash, zeroAddr, accounts[0], accounts[1], watcherReward, false, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);
    });

    it('should allow a watcher to refund ETH payment with refund-only reward on behalf of the sender after locktime', async function () {
        const lockTime = await currentEvmTime() + 1000;
        const params = [
            id,
            accounts[1],
            secretHash,
            lockTime,
            watcherReward,
            true
        ];
        let amount = web3.utils.toWei(web3.utils.toBN(1)).add(watcherReward);

        // not allow to refund if payment was not sent
        await this.swap.senderRefundReward(id, amount, secretHash, zeroAddr, accounts[0], accounts[1], watcherReward, true, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);

        await this.swap.ethPaymentReward(...params, { value: amount }).should.be.fulfilled;

        // not allow to refund before locktime
        await this.swap.senderRefundReward(id, amount, secretHash, zeroAddr, accounts[0], accounts[1], watcherReward, true, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);

        await increaseTime(1000);

        // not allow to refund invalid amount
        await this.swap.senderRefundReward(id, web3.utils.toWei('5'), secretHash, zeroAddr, accounts[0], accounts[1], watcherReward, true, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);

        // not allow to refund invalid watcher reward amount
        await this.swap.senderRefundReward(id, amount, secretHash, zeroAddr, accounts[0], accounts[1], web3.utils.toWei('5'), true, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);

        // not allow to refund with wrong sender address
        await this.swap.senderRefundReward(id, amount, secretHash, zeroAddr, accounts[2], accounts[1], watcherReward, true, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);

        // not allow to refund with wrong receiver address
        await this.swap.senderRefundReward(id, amount, secretHash, zeroAddr, accounts[0], accounts[2], watcherReward, true, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);

        const watcherBalanceBefore = web3.utils.toBN(await web3.eth.getBalance(accounts[2]));
        const senderBalanceBefore = web3.utils.toBN(await web3.eth.getBalance(accounts[0]));
        const gasPrice = web3.utils.toWei('100', 'gwei');

        // now allow to refund with regular watcher reward parameter
        await this.swap.senderRefundReward(id, amount, secretHash, zeroAddr, accounts[0], accounts[1], watcherReward, false, { from: accounts[2], gasPrice }).should.be.rejectedWith(EVMThrow);

        // success refund
        const tx = await this.swap.senderRefundReward(id, amount, secretHash, zeroAddr, accounts[0], accounts[1], watcherReward, true, { from: accounts[2], gasPrice }).should.be.fulfilled;
        const txFee = web3.utils.toBN(gasPrice).mul(web3.utils.toBN(tx.receipt.gasUsed));

        const watcherBalanceAfter = web3.utils.toBN(await web3.eth.getBalance(accounts[2]));
        const senderBalanceAfter = web3.utils.toBN(await web3.eth.getBalance(accounts[0]));

        // check watcher balance
        assert.equal(watcherBalanceAfter.sub(watcherBalanceBefore).toString(), watcherReward.sub(txFee));
        assert.equal(senderBalanceAfter.sub(senderBalanceBefore).toString(), web3.utils.toWei('1'));

        const payment = await this.swap.payments(id);
        assert.equal(payment[2].valueOf(), SENDER_REFUNDED);

        // not allow to refund again
        await this.swap.senderRefundReward(id, amount, secretHash, zeroAddr, accounts[0], accounts[1], watcherReward, true, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);
    });

    it('should allow a watcher to refund ERC20 payment with regular reward on behalf of the sender after locktime', async function () {
        const lockTime = await currentEvmTime() + 1000;
        let amount = web3.utils.toWei(web3.utils.toBN(1)).add(watcherReward);
        const params = [
            id,
            amount,
            this.token.address,
            accounts[1],
            secretHash,
            lockTime,
            watcherReward,
            false
        ];

        await this.token.approve(this.swap.address, amount);
        await this.swap.erc20PaymentReward(...params).should.be.fulfilled;

        // not allow to refund if payment was not sent
        await this.swap.senderRefundReward(id, amount, secretHash, this.token.address, accounts[0], accounts[1], watcherReward, false, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);

        // not allow to refund before locktime
        await this.swap.senderRefundReward(id, amount, secretHash, this.token.address, accounts[0], accounts[1], watcherReward, false, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);

        await increaseTime(1000);

        // not allow to refund invalid amount
        await this.swap.senderRefundReward(id, web3.utils.toWei('2'), secretHash, this.token.address, accounts[0], accounts[1], watcherReward, false, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);

        // not allow to refund with wrong sender address
        await this.swap.senderRefundReward(id, amount, secretHash, zeroAddr, accounts[2], accounts[1], watcherReward, false, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);

        // not allow to refund with wrong receiver address
        await this.swap.senderRefundReward(id, amount, secretHash, zeroAddr, accounts[0], accounts[2], watcherReward, false, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);
        
        // success refund
        const takerERC20BalanceBefore = web3.utils.toBN(await this.token.balanceOf(accounts[0]));
        const watcherERC20BalanceBefore = web3.utils.toBN(await this.token.balanceOf(accounts[2]));
        const watcherETHBalanceBefore = web3.utils.toBN(await web3.eth.getBalance(accounts[2]));

        const gasPrice = web3.utils.toWei('100', 'gwei');
        const tx = await this.swap.senderRefundReward(id, amount, secretHash, this.token.address, accounts[0], accounts[1], watcherReward, false, { from: accounts[2], gasPrice }).should.be.fulfilled;
        const txFee = web3.utils.toBN(gasPrice).mul(web3.utils.toBN(tx.receipt.gasUsed));

        const takerERC20BalanceAfter = web3.utils.toBN(await this.token.balanceOf(accounts[0]));
        const watcherERC20BalanceAfter = web3.utils.toBN(await this.token.balanceOf(accounts[2]));
        const watcherETHBalanceAfter = web3.utils.toBN(await web3.eth.getBalance(accounts[2]));

        // check sender balance
        assert.equal(takerERC20BalanceAfter.sub(takerERC20BalanceBefore).toString(), web3.utils.toWei('1'));
        assert.equal(watcherETHBalanceBefore.sub(watcherETHBalanceAfter).toString(), txFee.toString());
        assert.equal(watcherERC20BalanceAfter.sub(watcherERC20BalanceBefore).toString(), watcherReward.toString());

        const payment = await this.swap.payments(id);
        assert.equal(payment[2].valueOf(), SENDER_REFUNDED);

        // not allow to refund again
        await this.swap.senderRefundReward(id, web3.utils.toWei('1'), secretHash, this.token.address, accounts[0], accounts[1], watcherReward, false, {from: accounts[2] }).should.be.rejectedWith(EVMThrow);
    });

    it('should allow a watcher to refund ERC20 payment with refund-only reward on behalf of the sender after locktime', async function () {
        const lockTime = await currentEvmTime() + 1000;
        let amount = web3.utils.toWei(web3.utils.toBN(1)).add(watcherReward);
        const params = [
            id,
            amount,
            this.token.address,
            accounts[1],
            secretHash,
            lockTime,
            watcherReward,
            true
        ];

        await this.token.approve(this.swap.address, amount);
        await this.swap.erc20PaymentReward(...params).should.be.fulfilled;

        // not allow to refund if payment was not sent
        await this.swap.senderRefundReward(id, amount, secretHash, this.token.address, accounts[0], accounts[1], watcherReward, true, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);

        // not allow to refund before locktime
        await this.swap.senderRefundReward(id, amount, secretHash, this.token.address, accounts[0], accounts[1], watcherReward, true, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);

        await increaseTime(1000);

        // not allow to refund invalid amount
        await this.swap.senderRefundReward(id, web3.utils.toWei('2'), secretHash, this.token.address, accounts[0], accounts[1], watcherReward, true, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);

        // not allow to refund with wrong sender address
        await this.swap.senderRefundReward(id, amount, secretHash, zeroAddr, accounts[2], accounts[1], watcherReward, true, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);

        // not allow to refund with wrong receiver address
        await this.swap.senderRefundReward(id, amount, secretHash, zeroAddr, accounts[0], accounts[2], watcherReward, true, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);
        
        // success refund
        const senderERC20BalanceBefore = web3.utils.toBN(await this.token.balanceOf(accounts[0]));
        const watcherERC20BalanceBefore = web3.utils.toBN(await this.token.balanceOf(accounts[2]));
        const gasPrice = web3.utils.toWei('100', 'gwei');

        // now allow to refund with regular watcher reward parameter
        await this.swap.senderRefundReward(id, amount, secretHash, this.token.address, accounts[0], accounts[1], watcherReward, false, { from: accounts[2], gasPrice }).should.be.rejectedWith(EVMThrow);

        const tx = await this.swap.senderRefundReward(id, amount, secretHash, this.token.address, accounts[0], accounts[1], watcherReward, true, { from: accounts[2], gasPrice }).should.be.fulfilled;
        const txFee = web3.utils.toBN(gasPrice).mul(web3.utils.toBN(tx.receipt.gasUsed));

        const senderERC20BalanceAfter = web3.utils.toBN(await this.token.balanceOf(accounts[0]));
        const watcherERC20BalanceAfter = web3.utils.toBN(await this.token.balanceOf(accounts[2]));

        // check sender balance
        assert.equal(senderERC20BalanceAfter.sub(senderERC20BalanceBefore).toString(), web3.utils.toWei('1'));
        assert.equal(watcherERC20BalanceAfter.sub(watcherERC20BalanceBefore).toString(), watcherReward.toString());

        const payment = await this.swap.payments(id);
        assert.equal(payment[2].valueOf(), SENDER_REFUNDED);

        // not allow to refund again
        await this.swap.senderRefundReward(id, web3.utils.toWei('1'), secretHash, this.token.address, accounts[0], accounts[1], watcherReward, true, {from: accounts[2] }).should.be.rejectedWith(EVMThrow);
    });

    it('should allow a watcher to spend ETH payment on behalf of the receiver by revealing a secret', async function () {
        const lockTime = await currentEvmTime() + 1000;
        const params = [
            id,
            accounts[1],
            secretHash,
            lockTime,
            watcherReward,
            false
        ];
        let amount = web3.utils.toWei(web3.utils.toBN(1)).add(watcherReward);

        // should not allow to spend uninitialized payment
        await this.swap.receiverSpendReward(id, amount, secretHex, zeroAddr, accounts[0], accounts[1], watcherReward, false, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);

        await this.swap.ethPaymentReward(...params, { value: amount }).should.be.fulfilled;

        // should not allow to spend with invalid secret
        await this.swap.receiverSpendReward(id, amount, id, zeroAddr, accounts[0], accounts[1], watcherReward, false, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);
        
        // should not allow to spend invalid amount
        await this.swap.receiverSpendReward(id, web3.utils.toWei('5'), secretHex, zeroAddr, accounts[0], accounts[1], watcherReward, false, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);

        // should not allow to spend with wrong sender address
        await this.swap.receiverSpendReward(id, amount, secretHex, zeroAddr, accounts[2], accounts[1], watcherReward, false, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);

        // should not allow to spend with wrong receiver address
        await this.swap.receiverSpendReward(id, amount, secretHex, zeroAddr, accounts[0], accounts[2], watcherReward, false, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);

        // success spend
        const takerBalanceBefore = web3.utils.toBN(await web3.eth.getBalance(accounts[1]));
        const watcherBalanceBefore = web3.utils.toBN(await web3.eth.getBalance(accounts[2]));
        
        const gasPrice = web3.utils.toWei('100', 'gwei');
        const tx = await this.swap.receiverSpendReward(id, amount, secretHex, zeroAddr, accounts[0], accounts[1], watcherReward, false, { from: accounts[2], gasPrice }).should.be.fulfilled;
        const txFee = web3.utils.toBN(gasPrice).mul(web3.utils.toBN(tx.receipt.gasUsed));

        const takerBalanceAfter = web3.utils.toBN(await web3.eth.getBalance(accounts[1]));
        const watcherBalanceAfter = web3.utils.toBN(await web3.eth.getBalance(accounts[2]));

        // check receiver balance
        assert.equal(takerBalanceAfter.sub(takerBalanceBefore).toString(), web3.utils.toWei('1'));
        assert.equal(watcherBalanceAfter.sub(watcherBalanceBefore).add(txFee).toString(), watcherReward);

        const payment = await this.swap.payments(id);

        // status
        assert.equal(payment[2].valueOf(), RECEIVER_SPENT);

        // should not allow to spend again
        await this.swap.receiverSpendReward(id, amount, secretHex, zeroAddr, accounts[0], accounts[1], watcherReward, false, { from: accounts[2], gasPrice }).should.be.rejectedWith(EVMThrow);
    });

    it('should allow a watcher to spend ERC20 payment on behalf of the receiver by revealing a secret', async function () {
        const lockTime = await currentEvmTime() + 1000;
        let amount = web3.utils.toWei(web3.utils.toBN(1)).add(watcherReward);
        const params = [
            id,
            amount,
            this.token.address,
            accounts[1],
            secretHash,
            lockTime,
            watcherReward,
            false
        ];

        // should not allow to spend uninitialized payment
        await this.swap.receiverSpendReward(id, amount, secretHex, this.token.address, accounts[0], accounts[1], watcherReward, false, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);

        await this.token.approve(this.swap.address, amount);
        await this.swap.erc20PaymentReward(...params).should.be.fulfilled;

        // should not allow to spend with invalid secret
        await this.swap.receiverSpendReward(id, amount, id, this.token.address, accounts[0], accounts[1], watcherReward, false, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);
        // should not allow to spend invalid amount
        await this.swap.receiverSpendReward(id, web3.utils.toWei('2'), secretHex, this.token.address, accounts[0], accounts[1], watcherReward, false, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);

        // should not allow to spend with wrong sender address
        await this.swap.receiverSpendReward(id, amount, secretHex, zeroAddr, accounts[2], accounts[1], watcherReward, false, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);

        // should not allow to spend with wrong receiver address
        await this.swap.receiverSpendReward(id, amount, secretHex, zeroAddr, accounts[0], accounts[2], watcherReward, false, { from: accounts[2] }).should.be.rejectedWith(EVMThrow);

        // success spend
        const takerERC20BalanceBefore = web3.utils.toBN(await this.token.balanceOf(accounts[1]));
        const watcherETHBalanceBefore = web3.utils.toBN(await web3.eth.getBalance(accounts[2]));
        const watcherERC20BalanceBefore = web3.utils.toBN(await this.token.balanceOf(accounts[2]));

        const gasPrice = web3.utils.toWei('100', 'gwei');
        const tx = await this.swap.receiverSpendReward(id, amount, secretHex, this.token.address, accounts[0], accounts[1], watcherReward, false, { from: accounts[2], gasPrice }).should.be.fulfilled;
        const balanceAfter = web3.utils.toBN(await this.token.balanceOf(accounts[1]));
        const txFee = web3.utils.toBN(gasPrice).mul(web3.utils.toBN(tx.receipt.gasUsed));

        const takerERC20BalanceAfter = web3.utils.toBN(await this.token.balanceOf(accounts[1]));
        const watcherETHBalanceAfter = web3.utils.toBN(await web3.eth.getBalance(accounts[2]));
        const watcherERC20BalanceAfter = web3.utils.toBN(await this.token.balanceOf(accounts[2]));

        // check receiver balance
        assert.equal(takerERC20BalanceAfter.sub(takerERC20BalanceBefore).toString(), web3.utils.toWei('1'));
        assert.equal(watcherETHBalanceBefore.sub(watcherETHBalanceAfter).toString(), txFee.toString());
        assert.equal(watcherERC20BalanceAfter.sub(watcherERC20BalanceBefore), watcherReward.toString());

        const payment = await this.swap.payments(id);

        // status
        assert.equal(payment[2].valueOf(), RECEIVER_SPENT);

        // should not allow to spend again
        await this.swap.receiverSpendReward(id, amount, secretHex, this.token.address, accounts[0], accounts[1], watcherReward, false, { from: accounts[2], gasPrice }).should.be.rejectedWith(EVMThrow);
    });
});
