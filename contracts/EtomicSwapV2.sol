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

    mapping(bytes32 => MakerPayment) public maker_payments;

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
    event TakerPaymentSpent(bytes32 id, bytes32 secret);
    event TakerPaymentRefundedSecret(bytes32 id, bytes32 secret);
    event TakerPaymentRefundedTimelock(bytes32 id);

    mapping(bytes32 => TakerPayment) public taker_payments;

    address public dexFeeAddress;

    constructor(address feeAddress) {
        dexFeeAddress = feeAddress;
    }

    function ethMakerPayment(
        bytes32 id,
        address taker,
        bytes20 takerSecretHash,
        bytes20 makerSecretHash,
        uint32 paymentLockTime
    ) external payable {
        require(maker_payments[id].state == MakerPaymentState.Uninitialized, "Maker payment is already initialized");
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

        maker_payments[id] = MakerPayment(paymentHash, paymentLockTime, MakerPaymentState.PaymentSent);

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
        require(maker_payments[id].state == MakerPaymentState.Uninitialized, "Maker payment is already initialized");
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

        maker_payments[id] = MakerPayment(paymentHash, paymentLockTime, MakerPaymentState.PaymentSent);

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
        require(maker_payments[id].state == MakerPaymentState.PaymentSent, "Invalid payment state. Must be PaymentSent");

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
        require(paymentHash == maker_payments[id].paymentHash, "Invalid paymentHash");

        maker_payments[id].state = MakerPaymentState.TakerSpent;

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
            maker_payments[id].state == MakerPaymentState.PaymentSent,
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
            paymentHash == maker_payments[id].paymentHash,
            "Invalid paymentHash"
        );

        require(
            block.timestamp >= maker_payments[id].paymentLockTime,
            "Current timestamp didn't exceed payment refund lock time"
        );

        maker_payments[id].state = MakerPaymentState.MakerRefunded;

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
            maker_payments[id].state == MakerPaymentState.PaymentSent,
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
            paymentHash == maker_payments[id].paymentHash,
            "Invalid paymentHash"
        );

        maker_payments[id].state = MakerPaymentState.MakerRefunded;

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
        require(taker_payments[id].state == TakerPaymentState.Uninitialized, "Taker payment is already initialized");
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

        taker_payments[id] = TakerPayment(paymentHash, immediateRefundLockTime, paymentLockTime, TakerPaymentState.PaymentSent);

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
        require(taker_payments[id].state == TakerPaymentState.Uninitialized, "ERC20 v2 payment is already initialized");
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

        taker_payments[id] = TakerPayment(paymentHash, immediateRefundLockTime, paymentLockTime, TakerPaymentState.PaymentSent);

        emit TakerPaymentSent(id);

        // Now performing the external interaction
        IERC20 token = IERC20(tokenAddress);
        // Ensure that the token transfer from the sender to the contract is successful
        require(
            token.transferFrom(msg.sender, address(this), amount + dexFee),
            "ERC20 transfer failed: Insufficient balance or allowance"
        );
    }

    function spendTakerPayment(
        bytes32 id,
        uint256 amount,
        uint256 dexFee,
        bytes32 makerSecret,
        address sender,
        bytes20 takerSecretHash,
        address tokenAddress
    ) external {
        require(taker_payments[id].state == TakerPaymentState.PaymentSent, "Payment state is not PaymentSent");

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                amount,
                dexFee,
                msg.sender,
                sender,
                takerSecretHash,
                ripemd160(abi.encodePacked(sha256(abi.encodePacked(makerSecret)))),
                tokenAddress
            )
        );
        require(paymentHash == taker_payments[id].paymentHash, "Invalid paymentHash");

        taker_payments[id].state = TakerPaymentState.MakerSpent;

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

    function refundTakerPayment(
        bytes32 id,
        uint256 amount,
        uint256 dexFee,
        bytes20 takerSecretHash,
        bytes20 makerSecretHash,
        address tokenAddress,
        address receiver
    ) external {
        require(
            taker_payments[id].state == TakerPaymentState.PaymentSent,
            "Invalid payment state. Must be PaymentSent"
        );

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

        require(
            paymentHash == taker_payments[id].paymentHash,
            "Invalid paymentHash"
        );

        require(
            block.timestamp >= taker_payments[id].paymentLockTime,
            "Current timestamp didn't exceed payment refund lock time"
        );

        taker_payments[id].state = TakerPaymentState.TakerRefunded;

        emit TakerPaymentRefundedTimelock(id);

        uint256 total_amount = amount + dexFee;
        if (tokenAddress == address(0)) {
            payable(msg.sender).transfer(total_amount);
        } else {
            IERC20 token = IERC20(tokenAddress);
            require(token.transfer(msg.sender, total_amount));
        }
    }
}
