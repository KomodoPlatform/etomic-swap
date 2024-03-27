const {
    expect
} = require("chai");
const {
    ethers
} = require("hardhat");
const crypto = require('crypto');
const RIPEMD160 = require('ripemd160');
const {AbiCoder} = require("ethers");

require('chai')
    .use(require('chai-as-promised'))
    .should();

const INVALID_HASH = 'Invalid paymentHash';
const INVALID_PAYMENT_STATE_SENT = 'Invalid payment state. Must be PaymentSent';
const INVALID_PAYMENT_STATE_APPROVED = 'Invalid payment state. Must be TakerApproved';
const REFUND_TIMESTAMP_NOT_REACHED = 'Current timestamp didn\'t exceed payment refund lock time';
const PRE_APPROVE_REFUND_TIMESTAMP_NOT_REACHED = 'Current timestamp didn\'t exceed payment pre-approve lock time';

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
const takerSecretHash = '0x' + crypto.createHash('sha256').update(takerSecret).digest('hex');

const makerSecret = crypto.randomBytes(32);
const makerSecretHash = '0x' + crypto.createHash('sha256').update(makerSecret).digest('hex');

const invalidSecret = crypto.randomBytes(32);

const zeroAddr = '0x0000000000000000000000000000000000000000';
const dexFeeAddr = '0x8888888888888888888888888888888888888888';

describe("etomicSwapNft", function() {

    beforeEach(async function() {
        accounts = await ethers.getSigners();

        EtomicSwapNft = await ethers.getContractFactory("EtomicSwapNft");
        etomicSwapNft = await EtomicSwapNft.deploy(dexFeeAddr);
        await etomicSwapNft.waitForDeployment();

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
        const takerPayment = await etomicSwapNft.takerPayments(id);
        expect(Number(takerPayment[3])).to.equal(TAKER_PAYMENT_UNINITIALIZED);

        const makerPayment = await etomicSwapNft.makerPayments(id);
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

        // Make the Maker ERC721 payment. Call safeTransferFrom directly to transfer the token to the EtomicSwapNft contract.
        // Explicitly specify the method signature.
        await makerErc721Runner0['safeTransferFrom(address,address,uint256,bytes)'](accounts[0].address, etomicSwapNft.target, tokenId, data).should.be.fulfilled;

        // Check the payment lockTime and state
        const payment = await etomicSwapNft.makerPayments(id);
        expect(Number(payment[1])).to.equal(paymentLockTime);
        expect(Number(payment[2])).to.equal(MAKER_PAYMENT_SENT);

        // Should not allow to send again ( reverted with custom error ERC721InsufficientApproval )
        await expect(makerErc721Runner0['safeTransferFrom(address,address,uint256,bytes)'](accounts[0].address, etomicSwapNft.target, tokenId, data)).to.be.rejectedWith("ERC721InsufficientApproval");
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

        // Make the Maker ERC1155 payment. Call safeTransferFrom directly to transfer the token to the EtomicSwapNft contract.
        await makerErc1155Runner0.safeTransferFrom(accounts[0].address, etomicSwapNft.target, tokenId, amountToSend, data).should.be.fulfilled;

        // Check the payment lockTime and state
        const payment = await etomicSwapNft.makerPayments(id);
        expect(Number(payment[1])).to.equal(paymentLockTime);
        expect(Number(payment[2])).to.equal(MAKER_PAYMENT_SENT);

        // Check the balance of the token in the swap contract
        const tokenBalance = await erc1155token.balanceOf(etomicSwapNft.target, tokenId);
        expect(tokenBalance).to.equal(BigInt(amountToSend));

        // Check sending same params again - should fail
        await expect(makerErc1155Runner0.safeTransferFrom(accounts[0].address, etomicSwapNft.target, tokenId, amountToSend, data)).to.be.rejectedWith("ERC1155InsufficientBalance");

        // Maker should be capable to send more tokens, if they have it. Note: Check Erc1155.sol file. By default, ERC1155 is minted with 3 value.
        const id1 = '0x' + crypto.randomBytes(32).toString('hex');
        const data1 = abiCoder.encode(
            ['bytes32', 'address', 'address', 'bytes32', 'bytes32','uint32'],
            [id1, accounts[1].address, erc1155token.target, takerSecretHash, makerSecretHash, paymentLockTime]
        );
        await makerErc1155Runner0.safeTransferFrom(accounts[0].address, etomicSwapNft.target, tokenId, 1, data1).should.be.fulfilled;

        // Check sending more tokens than the sender owns - should fail
        const id2 = '0x' + crypto.randomBytes(32).toString('hex');
        const data2 = abiCoder.encode(
            ['bytes32', 'address', 'address', 'bytes32', 'bytes32','uint32'],
            [id2, accounts[1].address, erc1155token.target, takerSecretHash, makerSecretHash, paymentLockTime]
        );
        await expect(makerErc1155Runner0.safeTransferFrom(accounts[0].address, etomicSwapNft.target, tokenId, amountToSend, data2)).to.be.rejectedWith("ERC1155InsufficientBalance");
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

        // Make the Maker ERC721 payment. Call safeTransferFrom directly to transfer the token to the EtomicSwapNft contract.
        // Explicitly specify the method signature.
        await erc721token.connect(accounts[0])['safeTransferFrom(address,address,uint256,bytes)'](accounts[0].address, etomicSwapNft.target, tokenId, data).should.be.fulfilled;

        // Check the ownership of the token before Taker spend Maker ERC721 payment - should be owned by Swap NFT contract
        const tokenOwnerBeforeTakerSpend = await erc721token.ownerOf(tokenId);
        expect(tokenOwnerBeforeTakerSpend).to.equal(etomicSwapNft.target);

        const takerSwapRunner = etomicSwapNft.connect(accounts[1]);

        const spendParamsInvalidSecret = [
            id,
            accounts[0].address,
            takerSecretHash,
            invalidSecret,
            erc721token.target,
            tokenId,
            0
        ];
        // Attempt to spend with invalid secret - should fail
        await takerSwapRunner.spendNftMakerPayment(...spendParamsInvalidSecret).should.be.rejectedWith(INVALID_HASH);

        const spendParams = [
            id,
            accounts[0].address,
            takerSecretHash,
            makerSecret,
            erc721token.target,
            tokenId,
            0
        ];

        // should not allow to spend from non-taker address even with valid secret
        await etomicSwapNft.connect(accounts[2]).spendNftMakerPayment(...spendParams).should.be.rejectedWith(INVALID_HASH);

        // Successful spend by Taker with valid secret
        const tx = await takerSwapRunner.spendNftMakerPayment(...spendParams).should.be.fulfilled;
        const receipt = await tx.wait();
        console.log("Spend combined ERC721 Gas used:", receipt.gasUsed.toString());

        // Check the state of the payment
        const payment = await etomicSwapNft.makerPayments(id);
        expect(Number(payment[2])).to.equal(TAKER_SPENT);

        // Check the ownership of the token - should be transferred to the Taker (accounts[1])
        const tokenOwner = await erc721token.ownerOf(tokenId);
        expect(tokenOwner).to.equal(accounts[1].address);

        // should not allow to spend again
        await takerSwapRunner.spendNftMakerPayment(...spendParams).should.be.rejectedWith(INVALID_PAYMENT_STATE_SENT);
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

        // Make the Maker ERC1155 payment. Call safeTransferFrom directly to transfer the token to the EtomicSwapNft contract.
        await erc1155token.connect(accounts[0]).safeTransferFrom(accounts[0].address, etomicSwapNft.target, tokenId, amountToSend, data).should.be.fulfilled;

        // Check the balance of the token before Taker spend Maker ERC1155 payment - should be in Swap NFT contract
        let tokenBalanceBeforeTakerSpend = await erc1155token.balanceOf(etomicSwapNft.target, tokenId);
        expect(tokenBalanceBeforeTakerSpend).to.equal(BigInt(amountToSend));

        const takerSwapRunner = etomicSwapNft.connect(accounts[1]);

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
        await takerSwapRunner.spendNftMakerPayment(...spendParamsInvalidSecret).should.be.rejectedWith(INVALID_HASH);

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
        await etomicSwapNft.connect(accounts[2]).spendNftMakerPayment(...spendParams).should.be.rejectedWith(INVALID_HASH);

        // Successful spend by Taker with valid secret
        const tx = await takerSwapRunner.spendNftMakerPayment(...spendParams).should.be.fulfilled;
        const receipt = await tx.wait();
        console.log("Spend combined ERC1155 Gas used:", receipt.gasUsed.toString());

        // Check the state of the payment
        const payment = await etomicSwapNft.makerPayments(id);
        expect(Number(payment[2])).to.equal(TAKER_SPENT);

        // Check the balance of the token - should be transferred to the Taker (accounts[1])
        let tokenBalance = await erc1155token.balanceOf(accounts[1].address, tokenId);
        expect(tokenBalance).to.equal(BigInt(amountToSend));

        // Check that the Swap NFT contract no longer holds the tokens
        tokenBalance = await erc1155token.balanceOf(etomicSwapNft.target, tokenId);
        expect(tokenBalance).to.equal(BigInt(0));

        // should not allow to spend again
        await takerSwapRunner.spendNftMakerPayment(...spendParams).should.be.rejectedWith(INVALID_PAYMENT_STATE_SENT);
    });

    it('should allow maker to refund ERC721 payment after locktime', async function() {
        const lockTime = await currentEvmTime() + 1000;
        const tokenId = 1;

        const abiCoder = new AbiCoder();
        const data = abiCoder.encode(
            ['bytes32', 'address', 'address', 'bytes32', 'bytes32','uint32'],
            [id, accounts[1].address, erc721token.target, takerSecretHash, makerSecretHash, lockTime]
        );

        let makerSwapRunner = etomicSwapNft.connect(accounts[0]);

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

        // Make the Maker ERC721 payment. Call safeTransferFrom directly to transfer the token to the EtomicSwapNft contract.
        // Explicitly specify the method signature.
        await erc721token.connect(accounts[0])['safeTransferFrom(address,address,uint256,bytes)'](accounts[0].address, etomicSwapNft.target, tokenId, data).should.be.fulfilled;

        // Not allow to refund before locktime
        await makerSwapRunner.refundErc721MakerPaymentTimelock(...refundParams).should.be.rejectedWith(REFUND_TIMESTAMP_NOT_REACHED);

        // Simulate time passing to exceed the locktime
        await advanceTimeAndMine(1000);

        // Not allow to call refund from non-maker address
        await etomicSwapNft.connect(accounts[1]).refundErc721MakerPaymentTimelock(...refundParams).should.be.rejectedWith(INVALID_HASH);

        // Successful refund by maker after locktime
        await makerSwapRunner.refundErc721MakerPaymentTimelock(...refundParams).should.be.fulfilled;

        // Check the state of the payment
        const payment = await etomicSwapNft.makerPayments(id);
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

        let makerSwapRunner = etomicSwapNft.connect(accounts[0]);

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

        // Make the Maker ERC1155 payment. Call safeTransferFrom directly to transfer the token to the EtomicSwapNft contract.
        await erc1155token.connect(accounts[0]).safeTransferFrom(accounts[0].address, etomicSwapNft.target, tokenId, amountToSend, data).should.be.fulfilled;

        // Not allow to refund before locktime
        await makerSwapRunner.refundErc1155MakerPaymentTimelock(...refundParams).should.be.rejectedWith(REFUND_TIMESTAMP_NOT_REACHED);

        await advanceTimeAndMine(1000);

        // Not allow to call refund from non-maker address
        await etomicSwapNft.connect(accounts[1]).refundErc1155MakerPaymentTimelock(...refundParams).should.be.rejectedWith(INVALID_HASH)

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
        const payment = await etomicSwapNft.makerPayments(id);
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

        let makerSwapRunner = etomicSwapNft.connect(accounts[0]);

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

        // Make the Maker ERC721 payment. Call safeTransferFrom directly to transfer the token to the EtomicSwapNft contract.
        // Explicitly specify the method signature.
        await erc721token.connect(accounts[0])['safeTransferFrom(address,address,uint256,bytes)'](accounts[0].address, etomicSwapNft.target, tokenId, data).should.be.fulfilled;

        // Not allow to call refund from non-maker address
        await etomicSwapNft.connect(accounts[1]).refundErc721MakerPaymentSecret(...refundParams).should.be.rejectedWith(INVALID_HASH);

        // Successful refund by maker using taker secret
        await makerSwapRunner.refundErc721MakerPaymentSecret(...refundParams).should.be.fulfilled;

        // Check the state of the payment
        const payment = await etomicSwapNft.makerPayments(id);
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

        let makerSwapRunner = etomicSwapNft.connect(accounts[0]);

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

        // Make the Maker ERC1155 payment. Call safeTransferFrom directly to transfer the token to the EtomicSwapNft contract.
        await erc1155token.connect(accounts[0]).safeTransferFrom(accounts[0].address, etomicSwapNft.target, tokenId, amountToSend, data).should.be.fulfilled;

        // Not allow to call refund from non-maker address
        await etomicSwapNft.connect(accounts[1]).refundErc1155MakerPaymentSecret(...refundParams).should.be.rejectedWith(INVALID_HASH);

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
        const payment = await etomicSwapNft.makerPayments(id);
        expect(payment.state).to.equal(BigInt(MAKER_REFUNDED));

        // Do not allow to refund again
        await makerSwapRunner.refundErc1155MakerPaymentSecret(...refundParams).should.be.rejectedWith(INVALID_PAYMENT_STATE_SENT);
    });

    it('should allow taker to send ETH payment', async function() {
        let currentTime = await currentEvmTime();
        const immediateRefundLockTime = currentTime + 100;
        const paymentLockTime = currentTime + 100;
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
        await etomicSwapNft.connect(accounts[0]).ethTakerPayment(...params, {
            value: ethers.parseEther('1')
        }).should.be.fulfilled;

        const payment = await etomicSwapNft.takerPayments(id);

        expect(Number(payment[1])).to.equal(immediateRefundLockTime);
        expect(Number(payment[2])).to.equal(paymentLockTime);
        expect(Number(payment[3])).to.equal(TAKER_PAYMENT_SENT);

        // Check that it should not allow to send again
        await etomicSwapNft.connect(accounts[0]).ethTakerPayment(...params, {
            value: ethers.parseEther('1')
        }).should.be.rejectedWith("Taker payment is already initialized");
    });

    it('should allow taker to send ERC20 payment', async function() {
        const currentTime = await currentEvmTime();

        const immediateRefundLockTime = currentTime + 10;
        const paymentLockTime = currentTime + 100;

        const paymentParams = [
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

        let etomicSwapRunner0 = etomicSwapNft.connect(accounts[0]);

        await token.approve(etomicSwapNft.target, ethers.parseEther('1'));
        // Make the ERC20 payment
        await etomicSwapRunner0.erc20TakerPayment(...paymentParams).should.be.fulfilled;

        // Check contract token balance
        const balance = await token.balanceOf(etomicSwapNft.target);
        expect(balance).to.equal(ethers.parseEther('1'));

        const payment = await etomicSwapNft.takerPayments(id);

        // Check locktime and status
        expect(payment[1]).to.equal(BigInt(immediateRefundLockTime));
        expect(payment[2]).to.equal(BigInt(paymentLockTime));
        expect(payment[3]).to.equal(BigInt(TAKER_PAYMENT_SENT));

        // Should not allow to send payment again
        await etomicSwapRunner0.erc20TakerPayment(...paymentParams).should.be.rejectedWith("ERC20 v2 payment is already initialized");
    });

    it('should allow maker to spend ETH taker payment', async function() {
        let currentTime = await currentEvmTime();
        const immediateRefundLockTime = currentTime + 100;
        const paymentLockTime = currentTime + 100;
        const paymentParams = [
            id,
            ethers.parseEther('0.1'),
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            immediateRefundLockTime,
            paymentLockTime
        ];
        // Make the ETH payment
        await etomicSwapNft.connect(accounts[0]).ethTakerPayment(...paymentParams, {
            value: ethers.parseEther('1')
        }).should.be.fulfilled;

        const spendParams = [
            id,
            ethers.parseEther('0.9'),
            ethers.parseEther('0.1'),
            accounts[0].address,
            takerSecretHash,
            makerSecret,
            zeroAddr,
        ];

        // should not allow to spend before payment is approved by taker
        await etomicSwapNft.connect(accounts[1]).spendTakerPayment(...spendParams).should.be.rejectedWith(INVALID_PAYMENT_STATE_APPROVED);

        const approveParams = [
            id,
            ethers.parseEther('0.9'),
            ethers.parseEther('0.1'),
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            zeroAddr,
        ];

        await etomicSwapNft.connect(accounts[0]).takerPaymentApprove(...approveParams).should.be.fulfilled;

        // should not allow to spend from invalid address
        await etomicSwapNft.connect(accounts[0]).spendTakerPayment(...spendParams).should.be.rejectedWith(INVALID_HASH);

        // should not allow to spend with invalid amounts
        const invalidAmountParams = [
            id,
            ethers.parseEther('0.8'),
            ethers.parseEther('0.1'),
            accounts[0].address,
            takerSecretHash,
            makerSecret,
            zeroAddr,
        ];

        await etomicSwapNft.connect(accounts[1]).spendTakerPayment(...invalidAmountParams).should.be.rejectedWith(INVALID_HASH);

        const invalidDexFeeParams = [
            id,
            ethers.parseEther('0.9'),
            ethers.parseEther('0.2'),
            accounts[0].address,
            takerSecretHash,
            makerSecret,
            zeroAddr,
        ];

        await etomicSwapNft.connect(accounts[1]).spendTakerPayment(...invalidDexFeeParams).should.be.rejectedWith(INVALID_HASH);

        const balanceBefore = await ethers.provider.getBalance(accounts[1].address);
        const gasPrice = ethers.parseUnits('100', 'gwei');

        const spendTx = await etomicSwapNft.connect(accounts[1]).spendTakerPayment(...spendParams, {
            gasPrice
        }).should.be.fulfilled;

        const spendReceipt = await spendTx.wait();
        const gasUsed = ethers.parseUnits(spendReceipt.gasUsed.toString(), 'wei');
        const txFee = gasUsed * gasPrice;

        const balanceAfter = await ethers.provider.getBalance(accounts[1].address);
        // Check sender balance
        expect((balanceAfter - balanceBefore + txFee)).to.equal(ethers.parseEther('0.9'));

        const dexFeeAddrBalance = await ethers.provider.getBalance(dexFeeAddr);
        expect(dexFeeAddrBalance).to.equal(ethers.parseEther('0.1'));

        const payment = await etomicSwapNft.takerPayments(id);

        expect(Number(payment[3])).to.equal(MAKER_SPENT);

        // Do not allow to spend again
        await etomicSwapNft.connect(accounts[1]).spendTakerPayment(...spendParams).should.be.rejectedWith(INVALID_PAYMENT_STATE_APPROVED);
    });

    it('should allow maker to spend ERC20 taker payment', async function() {
        let currentTime = await currentEvmTime();
        const immediateRefundLockTime = currentTime + 100;
        const paymentLockTime = currentTime + 100;
        const paymentParams = [
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
        await token.approve(etomicSwapNft.target, ethers.parseEther('1'));
        await etomicSwapNft.connect(accounts[0]).erc20TakerPayment(...paymentParams).should.be.fulfilled;

        const contractBalance = await token.balanceOf(etomicSwapNft.target);
        expect(contractBalance).to.equal(ethers.parseEther('1'));

        const spendParams = [
            id,
            ethers.parseEther('0.9'), // amount
            ethers.parseEther('0.1'), // dexFee
            accounts[0].address,
            takerSecretHash,
            makerSecret,
            token.target, // tokenAddress
        ];

        // should not allow to spend before taker's approval
        await etomicSwapNft.connect(accounts[1]).spendTakerPayment(...spendParams).should.be.rejectedWith(INVALID_PAYMENT_STATE_APPROVED);

        const approveParams = [
            id,
            ethers.parseEther('0.9'),
            ethers.parseEther('0.1'),
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            token.target,
        ];

        await etomicSwapNft.connect(accounts[0]).takerPaymentApprove(...approveParams).should.be.fulfilled;

        // should not allow to spend from invalid address
        await etomicSwapNft.connect(accounts[0]).spendTakerPayment(...spendParams).should.be.rejectedWith(INVALID_HASH);

        // should not allow to spend with invalid amounts
        const invalidAmountParams = [
            id,
            ethers.parseEther('0.8'),
            ethers.parseEther('0.1'),
            accounts[0].address,
            takerSecretHash,
            makerSecret,
            token.target,
        ];

        await etomicSwapNft.connect(accounts[1]).spendTakerPayment(...invalidAmountParams).should.be.rejectedWith(INVALID_HASH);

        const invalidDexFeeParams = [
            id,
            ethers.parseEther('0.9'),
            ethers.parseEther('0.2'),
            accounts[0].address,
            takerSecretHash,
            makerSecret,
            token.target,
        ];

        await etomicSwapNft.connect(accounts[1]).spendTakerPayment(...invalidDexFeeParams).should.be.rejectedWith(INVALID_HASH);

        const balanceBefore = await token.balanceOf(accounts[1].address);

        const gasPrice = ethers.parseUnits('100', 'gwei');
        await etomicSwapNft.connect(accounts[1]).spendTakerPayment(...spendParams, {
            gasPrice
        }).should.be.fulfilled;

        const balanceAfter = await token.balanceOf(accounts[1].address);
        // Check receiver balance
        expect((balanceAfter - balanceBefore)).to.equal(ethers.parseEther('0.9'));

        const dexFeeAddrBalance = await token.balanceOf(dexFeeAddr);
        expect(dexFeeAddrBalance).to.equal(ethers.parseEther('0.1'));

        const payment = await etomicSwapNft.takerPayments(id);

        expect(Number(payment[3])).to.equal(MAKER_SPENT);

        // Do not allow to spend again
        await etomicSwapNft.connect(accounts[1]).spendTakerPayment(...spendParams).should.be.rejectedWith(INVALID_PAYMENT_STATE_APPROVED);
    });

    it('should allow taker to refund approved ETH payment after locktime', async function() {
        const preApproveLockTime = await currentEvmTime() + 3000;
        const paymentLockTime = await currentEvmTime() + 1000;
        const params = [
            id,
            ethers.parseEther('0.1'), // dexFee
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            preApproveLockTime,
            paymentLockTime
        ];

        let takerSwapRunner = etomicSwapNft.connect(accounts[0]);
        let makerSwapRunner = etomicSwapNft.connect(accounts[1]);

        // Not allow to refund if payment was not sent
        const refundParams = [
            id,
            ethers.parseEther('0.9'),
            ethers.parseEther('0.1'),
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            zeroAddr
        ];
        await takerSwapRunner.refundTakerPaymentTimelock(...refundParams).should.be.rejectedWith(INVALID_PAYMENT_STATE_SENT);

        // Make the ETH payment
        await takerSwapRunner.ethTakerPayment(...params, {
            value: ethers.parseEther('1')
        }).should.be.fulfilled;

        const approveParams = [
            id,
            ethers.parseEther('0.9'),
            ethers.parseEther('0.1'),
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            zeroAddr,
        ];
        await takerSwapRunner.takerPaymentApprove(...approveParams).should.be.fulfilled;

        // Not allow to refund before locktime
        await takerSwapRunner.refundTakerPaymentTimelock(...refundParams).should.be.rejectedWith(REFUND_TIMESTAMP_NOT_REACHED);

        // Simulate time passing to exceed the locktime
        await advanceTimeAndMine(1000);

        // Not allow to call refund from non-taker address
        await makerSwapRunner.refundTakerPaymentTimelock(...refundParams).should.be.rejectedWith(INVALID_HASH);

        // Not allow to refund invalid amount
        const invalidAmountParams = [
            id,
            ethers.parseEther('0.8'),
            ethers.parseEther('0.1'),
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            zeroAddr
        ];
        await takerSwapRunner.refundTakerPaymentTimelock(...invalidAmountParams).should.be.rejectedWith(INVALID_HASH);

        const invalidDexFeeParams = [
            id,
            ethers.parseEther('0.9'),
            ethers.parseEther('0.2'),
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            zeroAddr
        ];
        await takerSwapRunner.refundTakerPaymentTimelock(...invalidDexFeeParams).should.be.rejectedWith(INVALID_HASH);

        // Success refund
        const balanceBefore = await ethers.provider.getBalance(accounts[0].address);
        const gasPrice = ethers.parseUnits('100', 'gwei');

        const tx = await takerSwapRunner.refundTakerPaymentTimelock(...refundParams, {
            gasPrice
        }).should.be.fulfilled;

        const receipt = await tx.wait();
        const gasUsed = ethers.parseUnits(receipt.gasUsed.toString(), 'wei');
        const txFee = gasUsed * gasPrice;

        const balanceAfter = await ethers.provider.getBalance(accounts[0].address);
        // Check sender balance
        expect((balanceAfter - balanceBefore + txFee)).to.equal(ethers.parseEther('1'));

        // Check the state of the payment
        const payment = await etomicSwapNft.takerPayments(id);
        expect(payment.state).to.equal(BigInt(TAKER_REFUNDED));

        // Not allow to refund again
        await takerSwapRunner.refundTakerPaymentTimelock(...refundParams).should.be.rejectedWith(INVALID_PAYMENT_STATE_SENT);
    });

    it('should allow taker to refund non-approved ETH payment only after pre-approve locktime', async function() {
        const preApproveLockTime = await currentEvmTime() + 3000;
        const paymentLockTime = await currentEvmTime() + 1000;

        const params = [
            id,
            ethers.parseEther('0.1'), // dexFee
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            preApproveLockTime,
            paymentLockTime,
        ];

        let takerSwapRunner = etomicSwapNft.connect(accounts[0]);
        let makerSwapRunner = etomicSwapNft.connect(accounts[1]);

        // Not allow to refund if payment was not sent
        const refundParams = [
            id,
            ethers.parseEther('0.9'),
            ethers.parseEther('0.1'),
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            zeroAddr
        ];

        await takerSwapRunner.refundTakerPaymentTimelock(...refundParams).should.be.rejectedWith(INVALID_PAYMENT_STATE_SENT);

        // Make the ETH payment
        await takerSwapRunner.ethTakerPayment(...params, {
            value: ethers.parseEther('1')
        }).should.be.fulfilled;

        await advanceTimeAndMine(2000);

        // Not allow to refund before pre-approve locktime
        await takerSwapRunner.refundTakerPaymentTimelock(...refundParams).should.be.rejectedWith(PRE_APPROVE_REFUND_TIMESTAMP_NOT_REACHED);

        // Simulate time passing to exceed the locktime
        await advanceTimeAndMine(3000);

        // Not allow to call refund from non-sender address
        await makerSwapRunner.refundTakerPaymentTimelock(...refundParams).should.be.rejectedWith(INVALID_HASH);

        // Not allow to refund invalid amount
        const invalidAmountParams = [
            id,
            ethers.parseEther('0.8'),
            ethers.parseEther('0.1'),
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            zeroAddr
        ];

        await takerSwapRunner.refundTakerPaymentTimelock(...invalidAmountParams).should.be.rejectedWith(INVALID_HASH);

        const invalidDexFeeParams = [
            id,
            ethers.parseEther('0.9'),
            ethers.parseEther('0.2'),
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            zeroAddr
        ];

        await takerSwapRunner.refundTakerPaymentTimelock(...invalidDexFeeParams).should.be.rejectedWith(INVALID_HASH);

        // Success refund
        const balanceBefore = await ethers.provider.getBalance(accounts[0].address);
        const gasPrice = ethers.parseUnits('100', 'gwei');

        const tx = await takerSwapRunner.refundTakerPaymentTimelock(...refundParams, {
            gasPrice
        }).should.be.fulfilled;

        const receipt = await tx.wait();
        const gasUsed = ethers.parseUnits(receipt.gasUsed.toString(), 'wei');
        const txFee = gasUsed * gasPrice;

        const balanceAfter = await ethers.provider.getBalance(accounts[0].address);
        // Check sender balance
        expect((balanceAfter - balanceBefore + txFee)).to.equal(ethers.parseEther('1'));

        // Check the state of the payment
        const payment = await etomicSwapNft.takerPayments(id);
        expect(payment.state).to.equal(BigInt(TAKER_REFUNDED));

        // Not allow to refund again
        await takerSwapRunner.refundTakerPaymentTimelock(...refundParams).should.be.rejectedWith(INVALID_PAYMENT_STATE_SENT);
    });

    it('should allow taker to refund approved ERC20 payment after locktime', async function() {
        const preApproveLockTime = await currentEvmTime() + 3000;
        const paymentLockTime = await currentEvmTime() + 1000;

        const params = [
            id,
            ethers.parseEther('0.9'),
            ethers.parseEther('0.1'),
            token.target,
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            preApproveLockTime,
            paymentLockTime,
        ];

        let takerSwapRunner = etomicSwapNft.connect(accounts[0]);
        let makerSwapRunner = etomicSwapNft.connect(accounts[1]);

        await token.approve(etomicSwapNft.target, ethers.parseEther('1'));
        // Make the ERC20 payment
        await expect(takerSwapRunner.erc20TakerPayment(...params)).to.be.fulfilled;

        const refundParams = [
            id,
            ethers.parseEther('0.9'),
            ethers.parseEther('0.1'),
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            token.target,
        ];

        const approveParams = [
            id,
            ethers.parseEther('0.9'),
            ethers.parseEther('0.1'),
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            token.target,
        ];

        await takerSwapRunner.takerPaymentApprove(...approveParams).should.be.fulfilled;

        await takerSwapRunner.refundTakerPaymentTimelock(...refundParams).should.be.rejectedWith(REFUND_TIMESTAMP_NOT_REACHED);

        await advanceTimeAndMine(1000);

        // Not allow to call refund from non-sender address
        await makerSwapRunner.refundTakerPaymentTimelock(...refundParams).should.be.rejectedWith(INVALID_HASH);

        // Not allow to refund invalid amount
        const invalidAmountParams = [
            id,
            ethers.parseEther('0.8'),
            ethers.parseEther('0.1'),
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            token.target,
        ];

        await takerSwapRunner.refundTakerPaymentTimelock(...invalidAmountParams).should.be.rejectedWith(INVALID_HASH);

        const invalidDexFeeParams = [
            id,
            ethers.parseEther('0.9'),
            ethers.parseEther('0.2'),
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            token.target,
        ];

        await takerSwapRunner.refundTakerPaymentTimelock(...invalidDexFeeParams).should.be.rejectedWith(INVALID_HASH);

        // Success refund
        const balanceBefore = await token.balanceOf(accounts[0].address);

        await takerSwapRunner.refundTakerPaymentTimelock(...refundParams).should.be.fulfilled;

        const balanceAfter = await token.balanceOf(accounts[0].address);

        // Check sender balance
        expect((balanceAfter - balanceBefore)).to.equal(ethers.parseEther('1'));

        // Check the state of the payment
        const payment = await etomicSwapNft.takerPayments(id);
        expect(payment.state).to.equal(BigInt(TAKER_REFUNDED));

        // Do not allow to refund again
        await takerSwapRunner.refundTakerPaymentTimelock(...refundParams).should.be.rejectedWith(INVALID_PAYMENT_STATE_SENT);
    });

    it('should allow taker to refund non-approved ERC20 payment only after pre-approve locktime', async function() {
        const preApproveLockTime = await currentEvmTime() + 3000;
        const paymentLockTime = await currentEvmTime() + 1000;

        const params = [
            id,
            ethers.parseEther('0.9'),
            ethers.parseEther('0.1'),
            token.target,
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            preApproveLockTime,
            paymentLockTime,
        ];

        let takerSwapRunner = etomicSwapNft.connect(accounts[0]);
        let makerSwapRunner = etomicSwapNft.connect(accounts[1]);

        await token.approve(etomicSwapNft.target, ethers.parseEther('1'));
        // Make the ERC20 payment
        await expect(takerSwapRunner.erc20TakerPayment(...params)).to.be.fulfilled;

        const refundParams = [
            id,
            ethers.parseEther('0.9'),
            ethers.parseEther('0.1'),
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            token.target,
        ];

        await advanceTimeAndMine(2000);

        await takerSwapRunner.refundTakerPaymentTimelock(...refundParams).should.be.rejectedWith(PRE_APPROVE_REFUND_TIMESTAMP_NOT_REACHED);

        await advanceTimeAndMine(1000);

        // Not allow to call refund from non-sender address
        await makerSwapRunner.refundTakerPaymentTimelock(...refundParams).should.be.rejectedWith(INVALID_HASH);

        // Not allow to refund invalid amount
        const invalidAmountParams = [
            id,
            ethers.parseEther('0.8'),
            ethers.parseEther('0.1'),
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            token.target,
        ];

        await takerSwapRunner.refundTakerPaymentTimelock(...invalidAmountParams).should.be.rejectedWith(INVALID_HASH);

        const invalidDexFeeParams = [
            id,
            ethers.parseEther('0.9'),
            ethers.parseEther('0.2'),
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            token.target,
        ];

        await takerSwapRunner.refundTakerPaymentTimelock(...invalidDexFeeParams).should.be.rejectedWith(INVALID_HASH);

        // Success refund
        const balanceBefore = await token.balanceOf(accounts[0].address);

        await takerSwapRunner.refundTakerPaymentTimelock(...refundParams).should.be.fulfilled;

        const balanceAfter = await token.balanceOf(accounts[0].address);

        // Check sender balance
        expect((balanceAfter - balanceBefore)).to.equal(ethers.parseEther('1'));

        // Check the state of the payment
        const payment = await etomicSwapNft.takerPayments(id);
        expect(payment.state).to.equal(BigInt(TAKER_REFUNDED));

        // Do not allow to refund again
        await takerSwapRunner.refundTakerPaymentTimelock(...refundParams).should.be.rejectedWith(INVALID_PAYMENT_STATE_SENT);
    });

    it('should allow taker to refund ETH payment using secret', async function() {
        const preApproveLockTime = await currentEvmTime() + 3000;
        const paymentLockTime = await currentEvmTime() + 1000;

        const params = [
            id,
            ethers.parseEther('0.1'), // dexFee
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            preApproveLockTime,
            paymentLockTime,
        ];

        let etomicSwapRunner0 = etomicSwapNft.connect(accounts[0]);
        let etomicSwapRunner1 = etomicSwapNft.connect(accounts[1]);

        // Not allow to refund if payment was not sent
        const refundParams = [
            id,
            ethers.parseEther('0.9'),
            ethers.parseEther('0.1'),
            accounts[1].address,
            takerSecret,
            makerSecretHash,
            zeroAddr,
        ];

        await etomicSwapRunner0.refundTakerPaymentSecret(...refundParams).should.be.rejectedWith(INVALID_PAYMENT_STATE_SENT);

        // Make the ETH payment
        await etomicSwapRunner0.ethTakerPayment(...params, {
            value: ethers.parseEther('1')
        }).should.be.fulfilled;

        // Not allow to call refund from non-sender address
        await etomicSwapRunner1.refundTakerPaymentSecret(...refundParams).should.be.rejectedWith(INVALID_HASH);

        // Not allow to refund invalid amount
        const invalidAmountParams = [
            id,
            ethers.parseEther('0.8'),
            ethers.parseEther('0.1'),
            accounts[1].address,
            takerSecret,
            makerSecretHash,
            zeroAddr,
        ];

        await etomicSwapRunner0.refundTakerPaymentSecret(...invalidAmountParams).should.be.rejectedWith(INVALID_HASH);

        const invalidDexFeeParams = [
            id,
            ethers.parseEther('0.9'),
            ethers.parseEther('0.2'),
            accounts[1].address,
            takerSecret,
            makerSecretHash,
            zeroAddr,
        ];

        await etomicSwapRunner0.refundTakerPaymentSecret(...invalidDexFeeParams).should.be.rejectedWith(INVALID_HASH);

        // Success refund
        const balanceBefore = await ethers.provider.getBalance(accounts[0].address);
        const gasPrice = ethers.parseUnits('100', 'gwei');

        const tx = await etomicSwapRunner0.refundTakerPaymentSecret(...refundParams, {
            gasPrice
        }).should.be.fulfilled;

        const receipt = await tx.wait();
        const gasUsed = ethers.parseUnits(receipt.gasUsed.toString(), 'wei');
        const txFee = gasUsed * gasPrice;

        const balanceAfter = await ethers.provider.getBalance(accounts[0].address);
        // Check sender balance
        expect((balanceAfter - balanceBefore + txFee)).to.equal(ethers.parseEther('1'));

        // Check the state of the payment
        const payment = await etomicSwapNft.takerPayments(id);
        expect(payment.state).to.equal(BigInt(TAKER_REFUNDED));

        // Not allow to refund again
        await etomicSwapRunner0.refundTakerPaymentSecret(...refundParams).should.be.rejectedWith(INVALID_PAYMENT_STATE_SENT);
    });

    it('should allow taker to refund ERC20 payment using secret', async function() {
        const preApproveLockTime = await currentEvmTime() + 3000;
        const paymentLockTime = await currentEvmTime() + 1000;

        const params = [
            id,
            ethers.parseEther('0.9'),
            ethers.parseEther('0.1'),
            token.target,
            accounts[1].address,
            takerSecretHash,
            makerSecretHash,
            preApproveLockTime,
            paymentLockTime,
        ];

        let etomicSwapRunner0 = etomicSwapNft.connect(accounts[0]);
        let etomicSwapRunner1 = etomicSwapNft.connect(accounts[1]);

        await token.approve(etomicSwapNft.target, ethers.parseEther('1'));
        // Make the ERC20 payment
        await expect(etomicSwapRunner0.erc20TakerPayment(...params)).to.be.fulfilled;

        const refundParams = [
            id,
            ethers.parseEther('0.9'),
            ethers.parseEther('0.1'),
            accounts[1].address,
            takerSecret,
            makerSecretHash,
            token.target,
        ];

        // Not allow to call refund from non-sender address
        await etomicSwapRunner1.refundTakerPaymentSecret(...refundParams).should.be.rejectedWith(INVALID_HASH);

        // Not allow to refund invalid amount
        const invalidAmountParams = [
            id,
            ethers.parseEther('0.8'),
            ethers.parseEther('0.1'),
            accounts[1].address,
            takerSecret,
            makerSecretHash,
            token.target,
        ];

        await etomicSwapRunner0.refundTakerPaymentSecret(...invalidAmountParams).should.be.rejectedWith(INVALID_HASH);

        const invalidDexFeeParams = [
            id,
            ethers.parseEther('0.9'),
            ethers.parseEther('0.2'),
            accounts[1].address,
            takerSecret,
            makerSecretHash,
            token.target,
        ];

        await etomicSwapRunner0.refundTakerPaymentSecret(...invalidDexFeeParams).should.be.rejectedWith(INVALID_HASH);

        // Success refund
        const balanceBefore = await token.balanceOf(accounts[0].address);

        await etomicSwapRunner0.refundTakerPaymentSecret(...refundParams).should.be.fulfilled;

        const balanceAfter = await token.balanceOf(accounts[0].address);

        // Check sender balance
        expect((balanceAfter - balanceBefore)).to.equal(ethers.parseEther('1'));
        expect((balanceAfter - balanceBefore)).to.equal(ethers.parseEther('1'));

        // Check the state of the payment
        const payment = await etomicSwapNft.takerPayments(id);
        expect(payment.state).to.equal(BigInt(TAKER_REFUNDED));

        // Do not allow to refund again
        await etomicSwapRunner0.refundTakerPaymentSecret(...refundParams).should.be.rejectedWith(INVALID_PAYMENT_STATE_SENT);
    });
});
