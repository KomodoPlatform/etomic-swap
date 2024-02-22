// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract EtomicSwapV2 {
    enum MakerPaymentState {
        Uninitialized,
        PaymentSent,
        TakerSpent,
        MakerRefunded
    }

    struct MakerPayment {
        bytes20 paymentHash;
        uint32 paymentLockTime;
        MakerPaymentState state;
    }

    event MakerPaymentSent(bytes32 id);
    event MakerPaymentSpent(bytes32 id, bytes32 secret);
    event MakerPaymentRefundedTimelock(bytes32 id);
    event MakerPaymentRefundedSecret(bytes32 id, bytes32 secret);

    mapping(bytes32 => MakerPayment) public makerPayments;

    enum TakerPaymentState {
        Uninitialized,
        PaymentSent,
        TakerApproved,
        MakerSpent,
        TakerRefunded
    }

    struct TakerPayment {
        bytes20 paymentHash;
        uint32 immediateRefundTime;
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
        require(feeAddress != address(0), "feeAddress must not be zero address");

        dexFeeAddress = feeAddress;
    }

    function ethMakerPayment(
        bytes32 id,
        address taker,
        bytes20 takerSecretHash,
        bytes20 makerSecretHash,
        uint32 paymentLockTime
    ) external payable {
        require(makerPayments[id].state == MakerPaymentState.Uninitialized, "Maker payment is already initialized");
        require(taker != address(0), "Taker must not be zero address");
        require(msg.value > 0, "ETH value must be greater than zero");

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                msg.value,
                taker,
                msg.sender,
                takerSecretHash,
                makerSecretHash,
                address(0)
            )
        );

        makerPayments[id] = MakerPayment(paymentHash, paymentLockTime, MakerPaymentState.PaymentSent);

        emit MakerPaymentSent(id);
    }

    function erc20MakerPayment(
        bytes32 id,
        uint256 amount,
        address tokenAddress,
        address taker,
        bytes20 takerSecretHash,
        bytes20 makerSecretHash,
        uint32 paymentLockTime
    ) external {
        require(makerPayments[id].state == MakerPaymentState.Uninitialized, "Maker payment is already initialized");
        require(amount > 0, "Amount must not be zero");
        require(taker != address(0), "Taker must not be zero address");

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                amount,
                taker,
                msg.sender,
                takerSecretHash,
                makerSecretHash,
                tokenAddress
            )
        );

        makerPayments[id] = MakerPayment(paymentHash, paymentLockTime, MakerPaymentState.PaymentSent);

        emit MakerPaymentSent(id);

        // Now performing the external interaction
        IERC20 token = IERC20(tokenAddress);
        // Ensure that the token transfer from the sender to the contract is successful
        require(
            token.transferFrom(msg.sender, address(this), amount),
            "ERC20 transfer failed: Insufficient balance or allowance"
        );
    }

    function spendMakerPayment(
        bytes32 id,
        uint256 amount,
        address maker,
        bytes20 takerSecretHash,
        bytes32 makerSecret,
        address tokenAddress
    ) external {
        require(makerPayments[id].state == MakerPaymentState.PaymentSent, "Invalid payment state. Must be PaymentSent");

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                amount,
                msg.sender,
                maker,
                takerSecretHash,
                ripemd160(abi.encodePacked(sha256(abi.encodePacked(makerSecret)))),
                tokenAddress
            )
        );
        require(paymentHash == makerPayments[id].paymentHash, "Invalid paymentHash");

        makerPayments[id].state = MakerPaymentState.TakerSpent;

        if (tokenAddress == address(0)) {
            payable(msg.sender).transfer(amount);
        } else {
            IERC20 token = IERC20(tokenAddress);
            require(
                token.transfer(msg.sender, amount), "ERC20 transfer failed: Contract may lack balance or token transfer was rejected"
            );
        }
    }

    function refundMakerPaymentTimelock(
        bytes32 id,
        uint256 amount,
        address taker,
        bytes20 takerSecretHash,
        bytes20 makerSecretHash,
        address tokenAddress
    ) external {
        require(
            makerPayments[id].state == MakerPaymentState.PaymentSent,
            "Invalid payment state. Must be PaymentSent"
        );

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                amount,
                taker,
                msg.sender,
                takerSecretHash,
                makerSecretHash,
                tokenAddress
            )
        );

        require(
            paymentHash == makerPayments[id].paymentHash,
            "Invalid paymentHash"
        );

        require(
            block.timestamp >= makerPayments[id].paymentLockTime,
            "Current timestamp didn't exceed payment refund lock time"
        );

        makerPayments[id].state = MakerPaymentState.MakerRefunded;

        emit MakerPaymentRefundedTimelock(id);

        if (tokenAddress == address(0)) {
            payable(msg.sender).transfer(amount);
        } else {
            IERC20 token = IERC20(tokenAddress);
            require(token.transfer(msg.sender, amount));
        }
    }

    function refundMakerPaymentSecret(
        bytes32 id,
        uint256 amount,
        address taker,
        bytes32 takerSecret,
        bytes20 makerSecretHash,
        address tokenAddress
    ) external {
        require(
            makerPayments[id].state == MakerPaymentState.PaymentSent,
            "Invalid payment state. Must be PaymentSent"
        );

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                amount,
                taker,
                msg.sender,
                ripemd160(abi.encodePacked(sha256(abi.encodePacked(takerSecret)))),
                makerSecretHash,
                tokenAddress
            )
        );

        require(
            paymentHash == makerPayments[id].paymentHash,
            "Invalid paymentHash"
        );

        makerPayments[id].state = MakerPaymentState.MakerRefunded;

        emit MakerPaymentRefundedSecret(id, takerSecret);

        if (tokenAddress == address(0)) {
            payable(msg.sender).transfer(amount);
        } else {
            IERC20 token = IERC20(tokenAddress);
            require(token.transfer(msg.sender, amount));
        }
    }

    function ethTakerPayment(
        bytes32 id,
        uint256 dexFee,
        address receiver,
        bytes20 takerSecretHash,
        bytes20 makerSecretHash,
        uint32 immediateRefundLockTime,
        uint32 paymentLockTime
    ) external payable {
        require(takerPayments[id].state == TakerPaymentState.Uninitialized, "Taker payment is already initialized");
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
                address(0)
            )
        );

        takerPayments[id] = TakerPayment(paymentHash, immediateRefundLockTime, paymentLockTime, TakerPaymentState.PaymentSent);

        emit TakerPaymentSent(id);
    }

    function erc20TakerPayment(
        bytes32 id,
        uint256 amount,
        uint256 dexFee,
        address tokenAddress,
        address receiver,
        bytes20 takerSecretHash,
        bytes20 makerSecretHash,
        uint32 immediateRefundLockTime,
        uint32 paymentLockTime
    ) external {
        require(takerPayments[id].state == TakerPaymentState.Uninitialized, "ERC20 v2 payment is already initialized");
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

        takerPayments[id] = TakerPayment(paymentHash, immediateRefundLockTime, paymentLockTime, TakerPaymentState.PaymentSent);

        emit TakerPaymentSent(id);

        // Now performing the external interaction
        IERC20 token = IERC20(tokenAddress);
        // Ensure that the token transfer from the sender to the contract is successful
        require(
            token.transferFrom(msg.sender, address(this), amount + dexFee),
            "ERC20 transfer failed: Insufficient balance or allowance"
        );
    }

    function takerPaymentApprove(
        bytes32 id,
        uint256 amount,
        uint256 dexFee,
        address maker,
        bytes20 takerSecretHash,
        bytes20 makerSecretHash,
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

    function spendTakerPayment(
        bytes32 id,
        uint256 amount,
        uint256 dexFee,
        address taker,
        bytes20 takerSecretHash,
        bytes32 makerSecret,
        address tokenAddress
    ) external {
        require(takerPayments[id].state == TakerPaymentState.TakerApproved, "Invalid payment state. Must be TakerApproved");

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                amount,
                dexFee,
                msg.sender,
                taker,
                takerSecretHash,
                ripemd160(abi.encodePacked(sha256(abi.encodePacked(makerSecret)))),
                tokenAddress
            )
        );
        require(paymentHash == takerPayments[id].paymentHash, "Invalid paymentHash");

        takerPayments[id].state = TakerPaymentState.MakerSpent;

        if (tokenAddress == address(0)) {
            payable(msg.sender).transfer(amount);
            payable(dexFeeAddress).transfer(dexFee);
        } else {
            IERC20 token = IERC20(tokenAddress);
            require(
                token.transfer(msg.sender, amount), "ERC20 transfer failed: Contract may lack balance or token transfer was rejected"
            );
            require(
                token.transfer(dexFeeAddress, dexFee), "ERC20 transfer failed: Contract may lack balance or token transfer was rejected"
            );
        }
    }

    function refundTakerPaymentTimelock(
        bytes32 id,
        uint256 amount,
        uint256 dexFee,
        address maker,
        bytes20 takerSecretHash,
        bytes20 makerSecretHash,
        address tokenAddress
    ) external {
        require(
            takerPayments[id].state == TakerPaymentState.PaymentSent || takerPayments[id].state == TakerPaymentState.TakerApproved,
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

        require(
            block.timestamp >= takerPayments[id].paymentLockTime,
            "Current timestamp didn't exceed payment refund lock time"
        );

        takerPayments[id].state = TakerPaymentState.TakerRefunded;

        emit TakerPaymentRefundedTimelock(id);

        uint256 total_amount = amount + dexFee;
        if (tokenAddress == address(0)) {
            payable(msg.sender).transfer(total_amount);
        } else {
            IERC20 token = IERC20(tokenAddress);
            require(token.transfer(msg.sender, total_amount));
        }
    }

    function refundTakerPaymentSecret(
        bytes32 id,
        uint256 amount,
        uint256 dexFee,
        address maker,
        bytes32 takerSecret,
        bytes20 makerSecretHash,
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
                ripemd160(abi.encodePacked(sha256(abi.encodePacked(takerSecret)))),
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
            require(token.transfer(msg.sender, total_amount));
        }
    }
}
