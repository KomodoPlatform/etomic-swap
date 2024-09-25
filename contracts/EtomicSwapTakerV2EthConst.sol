// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract EtomicSwapTakerV2EthConst {
    using SafeERC20 for IERC20;

    address constant ETH_PLACEHOLDER_ADDRESS =
        0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    enum TakerPaymentState {
        Uninitialized,
        PaymentSent,
        TakerApproved,
        MakerSpent,
        TakerRefunded
    }

    struct TakerPayment {
        bytes20 paymentHash;
        uint32 preApproveLockTime;
        uint32 paymentLockTime;
        TakerPaymentState state;
    }

    event TakerPaymentSent(bytes32 id);
    event TakerPaymentApproved(bytes32 id);
    event TakerPaymentSpent(bytes32 id, bytes32 secret);
    event TakerPaymentRefundedSecret(bytes32 id, bytes32 secret);
    event TakerPaymentRefundedTimelock(bytes32 id);

    mapping(bytes32 => TakerPayment) public takerPayments;

    address public immutable dexFeeAddress;

    constructor(address feeAddress) {
        require(
            feeAddress != address(0),
            "feeAddress must not be zero address"
        );

        dexFeeAddress = feeAddress;
    }

    // func signature 0x9b4603f2
    function ethTakerPayment(
        bytes32 id,
        uint256 dexFee,
        address receiver,
        bytes32 takerSecretHash,
        bytes32 makerSecretHash,
        uint32 preApproveLockTime,
        uint32 paymentLockTime
    ) external payable {
        require(
            takerPayments[id].state == TakerPaymentState.Uninitialized,
            "Taker payment is already initialized"
        );
        require(receiver != address(0), "Receiver must not be zero address");
        require(msg.value > 0, "ETH value must be greater than zero");
        require(msg.value > dexFee, "ETH value must be greater than dex fee");

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                msg.value - dexFee,
                dexFee,
                receiver,
                msg.sender,
                takerSecretHash,
                makerSecretHash,
                ETH_PLACEHOLDER_ADDRESS
            )
        );

        takerPayments[id] = TakerPayment(
            paymentHash,
            preApproveLockTime,
            paymentLockTime,
            TakerPaymentState.PaymentSent
        );

        emit TakerPaymentSent(id);
    }

    // func signature 0xd6a71eb4
    function erc20TakerPayment(
        bytes32 id,
        uint256 amount,
        uint256 dexFee,
        address tokenAddress,
        address receiver,
        bytes32 takerSecretHash,
        bytes32 makerSecretHash,
        uint32 preApproveLockTime,
        uint32 paymentLockTime
    ) external {
        require(
            takerPayments[id].state == TakerPaymentState.Uninitialized,
            "ERC20 v2 payment is already initialized"
        );
        require(amount > 0, "Amount must not be zero");
        require(dexFee > 0, "Dex fee must not be zero");
        require(receiver != address(0), "Receiver must not be zero address");

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                amount,
                dexFee,
                receiver,
                msg.sender,
                takerSecretHash,
                makerSecretHash,
                tokenAddress
            )
        );

        takerPayments[id] = TakerPayment(
            paymentHash,
            preApproveLockTime,
            paymentLockTime,
            TakerPaymentState.PaymentSent
        );

        emit TakerPaymentSent(id);

        // Now performing the external interaction
        IERC20 token = IERC20(tokenAddress);
        token.safeTransferFrom(msg.sender, address(this), amount + dexFee);
    }

    // func signature is 0x146e5b24
    function takerPaymentApprove(
        bytes32 id,
        uint256 amount,
        uint256 dexFee,
        address maker,
        bytes32 takerSecretHash,
        bytes32 makerSecretHash,
        address tokenAddress
    ) external {
        require(
            takerPayments[id].state == TakerPaymentState.PaymentSent,
            "Invalid payment state. Must be PaymentSent"
        );

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                amount,
                dexFee,
                maker,
                msg.sender,
                takerSecretHash,
                makerSecretHash,
                tokenAddress
            )
        );

        require(
            paymentHash == takerPayments[id].paymentHash,
            "Invalid paymentHash"
        );

        takerPayments[id].state = TakerPaymentState.TakerApproved;

        emit TakerPaymentApproved(id);
    }

    // func signature 0xcc90c199
    function spendTakerPayment(
        bytes32 id,
        uint256 amount,
        uint256 dexFee,
        address taker,
        bytes32 takerSecretHash,
        bytes32 makerSecret,
        address tokenAddress
    ) external {
        require(
            takerPayments[id].state == TakerPaymentState.TakerApproved,
            "Invalid payment state. Must be TakerApproved"
        );

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                amount,
                dexFee,
                msg.sender,
                taker,
                takerSecretHash,
                sha256(abi.encodePacked(makerSecret)),
                tokenAddress
            )
        );
        require(
            paymentHash == takerPayments[id].paymentHash,
            "Invalid paymentHash"
        );

        takerPayments[id].state = TakerPaymentState.MakerSpent;

        emit TakerPaymentSpent(id, makerSecret);

        if (tokenAddress == address(0)) {
            payable(msg.sender).transfer(amount);
            payable(dexFeeAddress).transfer(dexFee);
        } else {
            IERC20 token = IERC20(tokenAddress);
            token.safeTransfer(msg.sender, amount);
            token.safeTransfer(dexFeeAddress, dexFee);
        }
    }

    // func signature 0x65e26617
    function refundTakerPaymentTimelock(
        bytes32 id,
        uint256 amount,
        uint256 dexFee,
        address maker,
        bytes32 takerSecretHash,
        bytes32 makerSecretHash,
        address tokenAddress
    ) external {
        require(
            takerPayments[id].state == TakerPaymentState.PaymentSent ||
                takerPayments[id].state == TakerPaymentState.TakerApproved,
            "Invalid payment state. Must be PaymentSent or TakerApproved"
        );

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                amount,
                dexFee,
                maker,
                msg.sender,
                takerSecretHash,
                makerSecretHash,
                tokenAddress
            )
        );

        require(
            paymentHash == takerPayments[id].paymentHash,
            "Invalid paymentHash"
        );

        if (takerPayments[id].state == TakerPaymentState.TakerApproved) {
            require(
                block.timestamp >= takerPayments[id].paymentLockTime,
                "Current timestamp didn't exceed payment refund lock time"
            );
        }

        if (takerPayments[id].state == TakerPaymentState.PaymentSent) {
            require(
                block.timestamp >= takerPayments[id].preApproveLockTime,
                "Current timestamp didn't exceed payment pre-approve lock time"
            );
        }

        takerPayments[id].state = TakerPaymentState.TakerRefunded;

        emit TakerPaymentRefundedTimelock(id);

        uint256 total_amount = amount + dexFee;
        if (tokenAddress == address(0)) {
            payable(msg.sender).transfer(total_amount);
        } else {
            IERC20 token = IERC20(tokenAddress);
            token.safeTransfer(msg.sender, total_amount);
        }
    }

    // func signature 0x3e6af5f2
    function refundTakerPaymentSecret(
        bytes32 id,
        uint256 amount,
        uint256 dexFee,
        address maker,
        bytes32 takerSecret,
        bytes32 makerSecretHash,
        address tokenAddress
    ) external {
        require(
            takerPayments[id].state == TakerPaymentState.PaymentSent,
            "Invalid payment state. Must be PaymentSent"
        );

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                amount,
                dexFee,
                maker,
                msg.sender,
                sha256(abi.encodePacked(takerSecret)),
                makerSecretHash,
                tokenAddress
            )
        );

        require(
            paymentHash == takerPayments[id].paymentHash,
            "Invalid paymentHash"
        );

        takerPayments[id].state = TakerPaymentState.TakerRefunded;

        emit TakerPaymentRefundedSecret(id, takerSecret);

        uint256 total_amount = amount + dexFee;
        if (tokenAddress == address(0)) {
            payable(msg.sender).transfer(total_amount);
        } else {
            IERC20 token = IERC20(tokenAddress);
            token.safeTransfer(msg.sender, total_amount);
        }
    }
}
