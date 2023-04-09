pragma solidity ^0.8.9;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract EtomicSwap {
    enum PaymentState {
        Uninitialized,
        PaymentSent,
        ReceiverSpent,
        SenderRefunded
    }

    enum RewardTargetOnSpend {
        None,
        Contract,
        PaymentSender,
        PaymentSpender
    }

    struct Payment {
        bytes20 paymentHash;
        uint64 lockTime;
        PaymentState state;
    }

    mapping (bytes32 => Payment) public payments;

    event PaymentSent(bytes32 id);
    event ReceiverSpent(bytes32 id, bytes32 secret);
    event SenderRefunded(bytes32 id);

    constructor() { }

    function ethPayment(
        bytes32 _id,
        address _receiver,
        bytes20 _secretHash,
        uint64 _lockTime
    ) external payable {
        require(_receiver != address(0) && msg.value > 0 && payments[_id].state == PaymentState.Uninitialized);

        bytes20 paymentHash = ripemd160(abi.encodePacked(
                _receiver,
                msg.sender,
                _secretHash,
                address(0),
                msg.value
            ));

        payments[_id] = Payment(
            paymentHash,
            _lockTime,
            PaymentState.PaymentSent
        );

        emit PaymentSent(_id);
    }

    function ethPaymentReward(
        bytes32 _id,
        address _receiver,
        bytes20 _secretHash,
        uint64 _lockTime,
        RewardTargetOnSpend _rewardTarget,
        bool _sendsContractRewardOnSpend,
        uint256 _rewardAmount
    ) external payable {
        require(_receiver != address(0) && msg.value > 0 && payments[_id].state == PaymentState.Uninitialized);

        bytes20 paymentHash = ripemd160(abi.encodePacked(
                _receiver,
                msg.sender,
                _secretHash,
                address(0),
                msg.value,
                _rewardTarget,
                _sendsContractRewardOnSpend,
                _rewardAmount
            ));

        payments[_id] = Payment(
            paymentHash,
            _lockTime,
            PaymentState.PaymentSent
        );

        emit PaymentSent(_id);
    }

    function erc20Payment(
        bytes32 _id,
        uint256 _amount,
        address _tokenAddress,
        address _receiver,
        bytes20 _secretHash,
        uint64 _lockTime
    ) external {
        require(_receiver != address(0) && _amount > 0 && payments[_id].state == PaymentState.Uninitialized);

        bytes20 paymentHash = ripemd160(abi.encodePacked(
                _receiver,
                msg.sender,
                _secretHash,
                _tokenAddress,
                _amount
            ));

        payments[_id] = Payment(
            paymentHash,
            _lockTime,
            PaymentState.PaymentSent
        );

        IERC20 token = IERC20(_tokenAddress);
        require(token.transferFrom(msg.sender, address(this), _amount));
        emit PaymentSent(_id);
    }

    function erc20PaymentReward(
        bytes32 _id,
        uint256 _amount,
        address _tokenAddress,
        address _receiver,
        bytes20 _secretHash,
        uint64 _lockTime,
        RewardTargetOnSpend _rewardTarget,
        bool _sendsContractRewardOnSpend,
        uint256 _rewardAmount
    ) external payable {
        require(_receiver != address(0) && _amount > 0 && payments[_id].state == PaymentState.Uninitialized);

        if (_rewardTarget != RewardTargetOnSpend.None && _rewardTarget != RewardTargetOnSpend.PaymentSpender) {
            require(msg.value == _rewardAmount);
        }

        bytes20 paymentHash = ripemd160(abi.encodePacked(
                _receiver,
                msg.sender,
                _secretHash,
                _tokenAddress,
                _amount,
                _rewardTarget,
                _sendsContractRewardOnSpend,
                _rewardAmount
            ));

        payments[_id] = Payment(
            paymentHash,
            _lockTime,
            PaymentState.PaymentSent
        );

        IERC20 token = IERC20(_tokenAddress);
        require(token.transferFrom(msg.sender, address(this), _amount));
        emit PaymentSent(_id);
    }

    function receiverSpend(
        bytes32 _id,
        uint256 _amount,
        bytes32 _secret,
        address _tokenAddress,
        address _sender
    ) external {
        require(payments[_id].state == PaymentState.PaymentSent);

        bytes20 paymentHash = ripemd160(abi.encodePacked(
                msg.sender,
                _sender,
                ripemd160(abi.encodePacked(sha256(abi.encodePacked(_secret)))),
                _tokenAddress,
                _amount
            ));

        require(paymentHash == payments[_id].paymentHash);
        payments[_id].state = PaymentState.ReceiverSpent;
        if (_tokenAddress == address(0)) {
            payable(msg.sender).transfer(_amount);
        } else {
            IERC20 token = IERC20(_tokenAddress);
            require(token.transfer(msg.sender, _amount));
        }

        emit ReceiverSpent(_id, _secret);
    }

    function receiverSpendReward(
        bytes32 _id,
        uint256 _amount,
        bytes32 _secret,
        address _tokenAddress,
        address _sender,
        address _receiver,
        RewardTargetOnSpend _rewardTarget,
        bool _sendsContractRewardOnSpend,
        uint256 _rewardAmount
    ) external {
        require(payments[_id].state == PaymentState.PaymentSent, "Payment was not sent");

        bytes20 paymentHash = ripemd160(abi.encodePacked(
                _receiver,
                _sender,
                ripemd160(abi.encodePacked(sha256(abi.encodePacked(_secret)))),
                _tokenAddress,
                _amount,
                _rewardTarget,
                _sendsContractRewardOnSpend,
                _rewardAmount
            ));

        require(paymentHash == payments[_id].paymentHash, "Invalid payment hash");
        payments[_id].state = PaymentState.ReceiverSpent;

        if (_tokenAddress == address(0)) {
            uint256 transferAmount = _rewardTarget == RewardTargetOnSpend.None ? _amount : _amount - _rewardAmount;
            payable(_receiver).transfer(transferAmount);

            if (_rewardTarget == RewardTargetOnSpend.PaymentSpender) {
                 payable(msg.sender).transfer(_rewardAmount);
            }
        } else {
            uint256 transferAmount = _rewardTarget == RewardTargetOnSpend.PaymentSpender ? _amount - _rewardAmount : _amount;
            IERC20 token = IERC20(_tokenAddress);
            require(token.transfer(_receiver, transferAmount), "Token transfer failed");

            if (_rewardTarget == RewardTargetOnSpend.PaymentSpender) {
                 require(token.transfer(msg.sender, _rewardAmount), "Token transfer failed");
            }
        }

        if (_rewardTarget == RewardTargetOnSpend.PaymentSender) {
            payable(_sender).transfer(_rewardAmount);
        }

        if (_sendsContractRewardOnSpend) {
            payable(msg.sender).transfer(_rewardAmount);
        }
        
        emit ReceiverSpent(_id, _secret);
    }

    function senderRefund(
        bytes32 _id,
        uint256 _amount,
        bytes20 _paymentHash,
        address _tokenAddress,
        address _receiver
    ) external {
        require(payments[_id].state == PaymentState.PaymentSent);

        bytes20 paymentHash = ripemd160(abi.encodePacked(
                _receiver,
                 msg.sender,
                _paymentHash,
                _tokenAddress,
                _amount
            ));

        require(paymentHash == payments[_id].paymentHash && block.timestamp >= payments[_id].lockTime);

        payments[_id].state = PaymentState.SenderRefunded;

        if (_tokenAddress == address(0)) {
            payable(msg.sender).transfer(_amount);
        } else {
            IERC20 token = IERC20(_tokenAddress);
            require(token.transfer(msg.sender, _amount));
        }

        emit SenderRefunded(_id);
    }

    function senderRefundReward(
        bytes32 _id,
        uint256 _amount,
        bytes20 _paymentHash,
        address _tokenAddress,
        address _sender,
        address _receiver,
        RewardTargetOnSpend _rewardTarget,
        bool _sendsReward,
        uint256 _rewardAmount
    ) external {
        require(payments[_id].state == PaymentState.PaymentSent);

        bytes20 paymentHash = ripemd160(abi.encodePacked(
                _receiver,
                _sender,
                _paymentHash,
                _tokenAddress,
                _amount,
                _rewardTarget,
                _sendsReward,
                _rewardAmount
            ));

        require(paymentHash == payments[_id].paymentHash && block.timestamp >= payments[_id].lockTime);

        payments[_id].state = PaymentState.SenderRefunded;

        if (_tokenAddress == address(0)) {
            uint256 transferAmount = _rewardTarget == RewardTargetOnSpend.None ? _amount : _amount - _rewardAmount;
            payable(_sender).transfer(transferAmount);

            if (_rewardTarget != RewardTargetOnSpend.None) {
                payable(msg.sender).transfer(_rewardAmount);
            }
        } else {
            uint256 transferAmount = _rewardTarget == RewardTargetOnSpend.PaymentSpender ? _amount - _rewardAmount : _amount;
            IERC20 token = IERC20(_tokenAddress);
            require(token.transfer(_sender, transferAmount));

            if (_rewardTarget == RewardTargetOnSpend.PaymentSpender) {
                require(token.transfer(msg.sender, _rewardAmount));
            } else if (_rewardTarget != RewardTargetOnSpend.None) {
                payable(msg.sender).transfer(_rewardAmount);
            }
        }

        emit SenderRefunded(_id);
    }
}
