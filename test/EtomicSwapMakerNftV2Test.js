const {
    expect
} = require("chai");
const {
    ethers
} = require("hardhat");
const crypto = require('crypto');
const {AbiCoder} = require("ethers");

require('chai')
    .use(require('chai-as-promised'))
    .should();

const INVALID_HASH = 'Invalid paymentHash';
const INVALID_PAYMENT_STATE_SENT = 'Invalid payment state. Must be PaymentSent';
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
const [MAKER_PAYMENT_UNINITIALIZED, MAKER_PAYMENT_SENT, TAKER_SPENT, MAKER_REFUNDED] = [0, 1, 2, 3];

const takerSecret = crypto.randomBytes(32);
const takerSecretHash = '0x' + crypto.createHash('sha256').update(takerSecret).digest('hex');

const makerSecret = crypto.randomBytes(32);
const makerSecretHash = '0x' + crypto.createHash('sha256').update(makerSecret).digest('hex');

const invalidSecret = crypto.randomBytes(32);

describe("EtomicSwapMakerNftV2", function() {

    beforeEach(async function() {
        accounts = await ethers.getSigners();

        EtomicSwapMakerNftV2 = await ethers.getContractFactory("EtomicSwapMakerNftV2");
        etomicSwapMakerNftV2 = await EtomicSwapMakerNftV2.deploy();
        await etomicSwapMakerNftV2.waitForDeployment();

        Token = await ethers.getContractFactory("Token");
        token = await Token.deploy();
        await token.waitForDeployment();

        Erc721Token = await ethers.getContractFactory("Erc721Token");
        erc721token = await Erc721Token.deploy("MyNFT", "MNFT");
        await erc721token.waitForDeployment();

        Erc1155Token = await ethers.getContractFactory("Erc1155Token");
        erc1155token = await Erc1155Token.deploy("uri");
        await erc1155token.waitForDeployment();

        await token.transfer(accounts[1].address, ethers.parseEther('100'));
    });

    it('should create contract with uninitialized payments', async function() {
        const makerPayment = await etomicSwapMakerNftV2.makerPayments(id);
        expect(Number(makerPayment[2])).to.equal(MAKER_PAYMENT_UNINITIALIZED);
    });

    it('should allow maker to send ERC721 payment', async function() {
        let currentTime = await currentEvmTime();
        const paymentLockTime = currentTime + 100;
        const tokenId = 1; // Assuming token ID 1 is minted to accounts[0] in Erc721Token contract

        const abiCoder = new AbiCoder();
        const data = abiCoder.encode(
            ['bytes32', 'address', 'address', 'bytes32', 'bytes32','uint32'],
            [id, accounts[1].address, erc721token.target, takerSecretHash, makerSecretHash, paymentLockTime]
        );

        const makerErc721Runner0 = erc721token.connect(accounts[0]);

        // Make the Maker ERC721 payment. Call safeTransferFrom directly to transfer the token to the etomicSwapMakerNftV2 contract.
        // Explicitly specify the method signature.
        const tx = await makerErc721Runner0['safeTransferFrom(address,address,uint256,bytes)'](accounts[0].address, etomicSwapMakerNftV2.target, tokenId, data).should.be.fulfilled;
        const receipt = await tx.wait();
        console.log(`Gas Used: ${receipt.gasUsed.toString()}`);

        // Check the payment lockTime and state
        const payment = await etomicSwapMakerNftV2.makerPayments(id);
        expect(Number(payment[1])).to.equal(paymentLockTime);
        expect(Number(payment[2])).to.equal(MAKER_PAYMENT_SENT);

        // Should not allow to send again ( reverted with custom error ERC721InsufficientApproval )
        await expect(makerErc721Runner0['safeTransferFrom(address,address,uint256,bytes)'](accounts[0].address, etomicSwapMakerNftV2.target, tokenId, data)).to.be.rejectedWith("ERC721InsufficientApproval");
    });

    it('should allow maker to send ERC1155 payment', async function() {
        let currentTime = await currentEvmTime();
        const paymentLockTime = currentTime + 100;
        const tokenId = 1; // Token ID used in Erc1155Token contract
        const amountToSend = 2; // Amount of tokens to send

        const abiCoder = new AbiCoder();
        const data = abiCoder.encode(
            ['bytes32', 'address', 'address', 'bytes32', 'bytes32','uint32'],
            [id, accounts[1].address, erc1155token.target, takerSecretHash, makerSecretHash, paymentLockTime]
        );

        const makerErc1155Runner0 = erc1155token.connect(accounts[0]);

        // Make the Maker ERC1155 payment. Call safeTransferFrom directly to transfer the token to the etomicSwapMakerNftV2 contract.
        const tx = await makerErc1155Runner0.safeTransferFrom(accounts[0].address, etomicSwapMakerNftV2.target, tokenId, amountToSend, data).should.be.fulfilled;
        const receipt = await tx.wait();
        console.log(`Gas Used: ${receipt.gasUsed.toString()}`);

        // Check the payment lockTime and state
        const payment = await etomicSwapMakerNftV2.makerPayments(id);
        expect(Number(payment[1])).to.equal(paymentLockTime);
        expect(Number(payment[2])).to.equal(MAKER_PAYMENT_SENT);

        // Check the balance of the token in the swap contract
        const tokenBalance = await erc1155token.balanceOf(etomicSwapMakerNftV2.target, tokenId);
        expect(tokenBalance).to.equal(BigInt(amountToSend));

        // Check sending same params again - should fail
        await expect(makerErc1155Runner0.safeTransferFrom(accounts[0].address, etomicSwapMakerNftV2.target, tokenId, amountToSend, data)).to.be.rejectedWith("ERC1155InsufficientBalance");

        // Maker should be capable to send more tokens, if they have it. Note: Check Erc1155.sol file. By default, ERC1155 is minted with 3 value.
        const id1 = '0x' + crypto.randomBytes(32).toString('hex');
        const data1 = abiCoder.encode(
            ['bytes32', 'address', 'address', 'bytes32', 'bytes32','uint32'],
            [id1, accounts[1].address, erc1155token.target, takerSecretHash, makerSecretHash, paymentLockTime]
        );
        await makerErc1155Runner0.safeTransferFrom(accounts[0].address, etomicSwapMakerNftV2.target, tokenId, 1, data1).should.be.fulfilled;

        // Check sending more tokens than the sender owns - should fail
        const id2 = '0x' + crypto.randomBytes(32).toString('hex');
        const data2 = abiCoder.encode(
            ['bytes32', 'address', 'address', 'bytes32', 'bytes32','uint32'],
            [id2, accounts[1].address, erc1155token.target, takerSecretHash, makerSecretHash, paymentLockTime]
        );
        await expect(makerErc1155Runner0.safeTransferFrom(accounts[0].address, etomicSwapMakerNftV2.target, tokenId, amountToSend, data2)).to.be.rejectedWith("ERC1155InsufficientBalance");
    });

    it('should allow taker to spend ERC721 maker payment', async function() {
        let currentTime = await currentEvmTime();
        const paymentLockTime = currentTime + 100;
        const tokenId = 1;

        const abiCoder = new AbiCoder();
        const data = abiCoder.encode(
            ['bytes32', 'address', 'address', 'bytes32', 'bytes32','uint32'],
            [id, accounts[1].address, erc721token.target, takerSecretHash, makerSecretHash, paymentLockTime]
        );

        // Make the Maker ERC721 payment. Call safeTransferFrom directly to transfer the token to the etomicSwapMakerNftV2 contract.
        // Explicitly specify the method signature.
        await erc721token.connect(accounts[0])['safeTransferFrom(address,address,uint256,bytes)'](accounts[0].address, etomicSwapMakerNftV2.target, tokenId, data).should.be.fulfilled;

        // Check the ownership of the token before Taker spend Maker ERC721 payment - should be owned by Swap NFT contract
        const tokenOwnerBeforeTakerSpend = await erc721token.ownerOf(tokenId);
        expect(tokenOwnerBeforeTakerSpend).to.equal(etomicSwapMakerNftV2.target);

        const takerSwapRunner = etomicSwapMakerNftV2.connect(accounts[1]);

        const spendParamsInvalidSecret = [
            id,
            accounts[0].address,
            takerSecretHash,
            invalidSecret,
            erc721token.target,
            tokenId
        ];
        // Attempt to spend with invalid secret - should fail
        await takerSwapRunner.spendErc721MakerPayment(...spendParamsInvalidSecret).should.be.rejectedWith(INVALID_HASH);

        const spendParams = [
            id,
            accounts[0].address,
            takerSecretHash,
            makerSecret,
            erc721token.target,
            tokenId
        ];

        // should not allow to spend from non-taker address even with valid secret
        await etomicSwapMakerNftV2.connect(accounts[2]).spendErc721MakerPayment(...spendParams).should.be.rejectedWith(INVALID_HASH);

        // Successful spend by Taker with valid secret
        await takerSwapRunner.spendErc721MakerPayment(...spendParams).should.be.fulfilled;

        // Check the state of the payment
        const payment = await etomicSwapMakerNftV2.makerPayments(id);
        expect(Number(payment[2])).to.equal(TAKER_SPENT);

        // Check the ownership of the token - should be transferred to the Taker (accounts[1])
        const tokenOwner = await erc721token.ownerOf(tokenId);
        expect(tokenOwner).to.equal(accounts[1].address);

        // should not allow to spend again
        await takerSwapRunner.spendErc721MakerPayment(...spendParams).should.be.rejectedWith(INVALID_PAYMENT_STATE_SENT);
    })

    it('should allow taker to spend ERC1155 maker payment', async function() {
        let currentTime = await currentEvmTime();
        const paymentLockTime = currentTime + 100;
        const tokenId = 1; // Token ID used in Erc1155Token contract
        const amountToSend = 2; // Amount of tokens to send

        const abiCoder = new AbiCoder();
        const data = abiCoder.encode(
            ['bytes32', 'address', 'address', 'bytes32', 'bytes32','uint32'],
            [id, accounts[1].address, erc1155token.target, takerSecretHash, makerSecretHash, paymentLockTime]
        );

        // Make the Maker ERC1155 payment. Call safeTransferFrom directly to transfer the token to the etomicSwapMakerNftV2 contract.
        await erc1155token.connect(accounts[0]).safeTransferFrom(accounts[0].address, etomicSwapMakerNftV2.target, tokenId, amountToSend, data).should.be.fulfilled;

        // Check the balance of the token before Taker spend Maker ERC1155 payment - should be in Swap NFT contract
        let tokenBalanceBeforeTakerSpend = await erc1155token.balanceOf(etomicSwapMakerNftV2.target, tokenId);
        expect(tokenBalanceBeforeTakerSpend).to.equal(BigInt(amountToSend));

        const takerSwapRunner = etomicSwapMakerNftV2.connect(accounts[1]);

        const spendParamsInvalidSecret = [
            id,
            accounts[0].address,
            takerSecretHash,
            invalidSecret,
            erc1155token.target,
            tokenId,
            amountToSend
        ];
        // Attempt to spend with invalid secret - should fail
        await takerSwapRunner.spendErc1155MakerPayment(...spendParamsInvalidSecret).should.be.rejectedWith(INVALID_HASH);

        const spendParams = [
            id,
            accounts[0].address,
            takerSecretHash,
            makerSecret,
            erc1155token.target,
            tokenId,
            amountToSend
        ];

        // should not allow to spend from non-taker address even with valid secret
        await etomicSwapMakerNftV2.connect(accounts[2]).spendErc1155MakerPayment(...spendParams).should.be.rejectedWith(INVALID_HASH);

        // Successful spend by Taker with valid secret
        await takerSwapRunner.spendErc1155MakerPayment(...spendParams).should.be.fulfilled;

        // Check the state of the payment
        const payment = await etomicSwapMakerNftV2.makerPayments(id);
        expect(Number(payment[2])).to.equal(TAKER_SPENT);

        // Check the balance of the token - should be transferred to the Taker (accounts[1])
        let tokenBalance = await erc1155token.balanceOf(accounts[1].address, tokenId);
        expect(tokenBalance).to.equal(BigInt(amountToSend));

        // Check that the Swap NFT contract no longer holds the tokens
        tokenBalance = await erc1155token.balanceOf(etomicSwapMakerNftV2.target, tokenId);
        expect(tokenBalance).to.equal(BigInt(0));

        // should not allow to spend again
        await takerSwapRunner.spendErc1155MakerPayment(...spendParams).should.be.rejectedWith(INVALID_PAYMENT_STATE_SENT);
    });

    it('should allow maker to refund ERC721 payment after locktime', async function() {
        const lockTime = await currentEvmTime() + 1000;
        const tokenId = 1;

        const abiCoder = new AbiCoder();
        const data = abiCoder.encode(
            ['bytes32', 'address', 'address', 'bytes32', 'bytes32','uint32'],
            [id, accounts[1].address, erc721token.target, takerSecretHash, makerSecretHash, lockTime]
        );

        let makerSwapRunner = etomicSwapMakerNftV2.connect(accounts[0]);

        // Not allow maker to refund if payment was not sent
        const refundParams = [
            id,
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            erc721token.target,
            tokenId
        ];
        await makerSwapRunner.refundErc721MakerPaymentTimelock(...refundParams).should.be.rejectedWith(INVALID_PAYMENT_STATE_SENT);

        // Make the Maker ERC721 payment. Call safeTransferFrom directly to transfer the token to the etomicSwapMakerNftV2 contract.
        // Explicitly specify the method signature.
        await erc721token.connect(accounts[0])['safeTransferFrom(address,address,uint256,bytes)'](accounts[0].address, etomicSwapMakerNftV2.target, tokenId, data).should.be.fulfilled;

        // Not allow to refund before locktime
        await makerSwapRunner.refundErc721MakerPaymentTimelock(...refundParams).should.be.rejectedWith(REFUND_TIMESTAMP_NOT_REACHED);

        // Simulate time passing to exceed the locktime
        await advanceTimeAndMine(1000);

        // Not allow to call refund from non-maker address
        await etomicSwapMakerNftV2.connect(accounts[1]).refundErc721MakerPaymentTimelock(...refundParams).should.be.rejectedWith(INVALID_HASH);

        // Successful refund by maker after locktime
        await makerSwapRunner.refundErc721MakerPaymentTimelock(...refundParams).should.be.fulfilled;

        // Check the state of the payment
        const payment = await etomicSwapMakerNftV2.makerPayments(id);
        expect(payment.state).to.equal(BigInt(MAKER_REFUNDED));

        // Not allow maker to refund again
        await makerSwapRunner.refundErc721MakerPaymentTimelock(...refundParams).should.be.rejectedWith(INVALID_PAYMENT_STATE_SENT);
    });

    it('should allow maker to refund ERC1155 payment after locktime', async function() {
        const lockTime = await currentEvmTime() + 1000;
        const tokenId = 1; // Token ID used in Erc1155Token contract
        const amountToSend = 3; // Amount of tokens to send

        const abiCoder = new AbiCoder();
        const data = abiCoder.encode(
            ['bytes32', 'address', 'address', 'bytes32', 'bytes32','uint32'],
            [id, accounts[1].address, erc1155token.target, takerSecretHash, makerSecretHash, lockTime]
        );

        let makerSwapRunner = etomicSwapMakerNftV2.connect(accounts[0]);

        const refundParams = [
            id,
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            erc1155token.target,
            tokenId,
            amountToSend
        ];

        // Not allow maker to refund if payment was not sent
        await makerSwapRunner.refundErc1155MakerPaymentTimelock(...refundParams).should.be.rejectedWith(INVALID_PAYMENT_STATE_SENT);

        // Make the Maker ERC1155 payment. Call safeTransferFrom directly to transfer the token to the etomicSwapMakerNftV2 contract.
        await erc1155token.connect(accounts[0]).safeTransferFrom(accounts[0].address, etomicSwapMakerNftV2.target, tokenId, amountToSend, data).should.be.fulfilled;

        // Not allow to refund before locktime
        await makerSwapRunner.refundErc1155MakerPaymentTimelock(...refundParams).should.be.rejectedWith(REFUND_TIMESTAMP_NOT_REACHED);

        await advanceTimeAndMine(1000);

        // Not allow to call refund from non-maker address
        await etomicSwapMakerNftV2.connect(accounts[1]).refundErc1155MakerPaymentTimelock(...refundParams).should.be.rejectedWith(INVALID_HASH)

        // Not allow to refund invalid amount
        const invalidAmountParams = [
            id,
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            erc1155token.target,
            tokenId,
            2
        ];
        await makerSwapRunner.refundErc1155MakerPaymentTimelock(...invalidAmountParams).should.be.rejectedWith(INVALID_HASH);

        // Successful refund by maker after locktime
        await makerSwapRunner.refundErc1155MakerPaymentTimelock(...refundParams).should.be.fulfilled;

        // Check the state of the payment
        const payment = await etomicSwapMakerNftV2.makerPayments(id);
        expect(payment.state).to.equal(BigInt(MAKER_REFUNDED));

        // Check the balance of the token - should be back to the maker (accounts[0])
        const tokenBalance = await erc1155token.balanceOf(accounts[0].address, tokenId);
        expect(tokenBalance).to.equal(BigInt(amountToSend));

        // Do not allow to refund again
        await makerSwapRunner.refundErc1155MakerPaymentTimelock(...refundParams).should.be.rejectedWith(INVALID_PAYMENT_STATE_SENT);
    });

    it('should allow maker to refund ERC721 payment using taker secret', async function() {
        const lockTime = await currentEvmTime() + 1000;
        const tokenId = 1;

        const abiCoder = new AbiCoder();
        const data = abiCoder.encode(
            ['bytes32', 'address', 'address', 'bytes32', 'bytes32','uint32'],
            [id, accounts[1].address, erc721token.target, takerSecretHash, makerSecretHash, lockTime]
        );

        let makerSwapRunner = etomicSwapMakerNftV2.connect(accounts[0]);

        // Not allow to refund if payment was not sent
        const refundParams = [
            id,
            accounts[1].address,
            takerSecret,
            makerSecretHash,
            erc721token.target,
            tokenId
        ];
        await makerSwapRunner.refundErc721MakerPaymentSecret(...refundParams).should.be.rejectedWith(INVALID_PAYMENT_STATE_SENT);

        // Make the Maker ERC721 payment. Call safeTransferFrom directly to transfer the token to the etomicSwapMakerNftV2 contract.
        // Explicitly specify the method signature.
        await erc721token.connect(accounts[0])['safeTransferFrom(address,address,uint256,bytes)'](accounts[0].address, etomicSwapMakerNftV2.target, tokenId, data).should.be.fulfilled;

        // Not allow to call refund from non-maker address
        await etomicSwapMakerNftV2.connect(accounts[1]).refundErc721MakerPaymentSecret(...refundParams).should.be.rejectedWith(INVALID_HASH);

        // Successful refund by maker using taker secret
        await makerSwapRunner.refundErc721MakerPaymentSecret(...refundParams).should.be.fulfilled;

        // Check the state of the payment
        const payment = await etomicSwapMakerNftV2.makerPayments(id);
        expect(payment.state).to.equal(BigInt(MAKER_REFUNDED));

        // Not allow maker to refund again
        await makerSwapRunner.refundErc721MakerPaymentSecret(...refundParams).should.be.rejectedWith(INVALID_PAYMENT_STATE_SENT);
    });

    it('should allow maker to refund ERC1155 payment using taker secret', async function() {
        const lockTime = await currentEvmTime() + 1000;
        const tokenId = 1; // Token ID used in Erc1155Token contract
        const amountToSend = 3; // Amount of tokens to send

        const abiCoder = new AbiCoder();
        const data = abiCoder.encode(
            ['bytes32', 'address', 'address', 'bytes32', 'bytes32','uint32'],
            [id, accounts[1].address, erc1155token.target, takerSecretHash, makerSecretHash, lockTime]
        );

        let makerSwapRunner = etomicSwapMakerNftV2.connect(accounts[0]);

        const refundParams = [
            id,
            accounts[1].address,
            takerSecret,
            makerSecretHash,
            erc1155token.target,
            tokenId,
            amountToSend
        ];

        // Not allow maker to refund if payment was not sent
        await makerSwapRunner.refundErc1155MakerPaymentSecret(...refundParams).should.be.rejectedWith(INVALID_PAYMENT_STATE_SENT);

        // Make the Maker ERC1155 payment. Call safeTransferFrom directly to transfer the token to the etomicSwapMakerNftV2 contract.
        await erc1155token.connect(accounts[0]).safeTransferFrom(accounts[0].address, etomicSwapMakerNftV2.target, tokenId, amountToSend, data).should.be.fulfilled;

        // Not allow to call refund from non-maker address
        await etomicSwapMakerNftV2.connect(accounts[1]).refundErc1155MakerPaymentSecret(...refundParams).should.be.rejectedWith(INVALID_HASH);

        // Not allow to refund invalid amount
        const invalidAmountParams = [
            id,
            accounts[1].address,
            takerSecret,
            makerSecretHash,
            erc1155token.target,
            tokenId,
            2
        ];
        await makerSwapRunner.refundErc1155MakerPaymentSecret(...invalidAmountParams).should.be.rejectedWith(INVALID_HASH);

        // Success refund
        await makerSwapRunner.refundErc1155MakerPaymentSecret(...refundParams).should.be.fulfilled;

        // Successful refund by maker using taker secret
        const payment = await etomicSwapMakerNftV2.makerPayments(id);
        expect(payment.state).to.equal(BigInt(MAKER_REFUNDED));

        // Do not allow to refund again
        await makerSwapRunner.refundErc1155MakerPaymentSecret(...refundParams).should.be.rejectedWith(INVALID_PAYMENT_STATE_SENT);
    });

});

