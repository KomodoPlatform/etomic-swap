// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";

contract EtomicSwapNft is ERC165, IERC1155Receiver, IERC721Receiver {
    using SafeERC20 for IERC20;

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
    event MakerPaymentSpent(bytes32 id);
    event MakerPaymentRefundedTimelock(bytes32 id);
    event MakerPaymentRefundedSecret(bytes32 id);

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

    function spendErc721MakerPayment(
        bytes32 id,
        address maker,
        bytes32 takerSecretHash,
        bytes32 makerSecret,
        address tokenAddress,
        uint256 tokenId
    ) external {
        require(
            makerPayments[id].state == MakerPaymentState.PaymentSent,
            "Invalid payment state. Must be PaymentSent"
        );

        // Check if the function caller is an externally owned account (EOA)
        require(msg.sender == tx.origin, "Caller must be an EOA");

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                msg.sender,
                maker,
                takerSecretHash,
                sha256(abi.encodePacked(makerSecret)),
                tokenAddress,
                tokenId
            )
        );
        require(
            paymentHash == makerPayments[id].paymentHash,
            "Invalid paymentHash"
        );

        // Effects
        makerPayments[id].state = MakerPaymentState.TakerSpent;

        // Event Emission
        emit MakerPaymentSpent(id);

        // Interactions
        IERC721 token = IERC721(tokenAddress);
        token.safeTransferFrom(address(this), msg.sender, tokenId);
    }

    function spendErc1155MakerPayment(
        bytes32 id,
        uint256 amount,
        address maker,
        bytes32 takerSecretHash,
        bytes32 makerSecret,
        address tokenAddress,
        uint256 tokenId
    ) external {
        require(
            makerPayments[id].state == MakerPaymentState.PaymentSent,
            "Invalid payment state. Must be PaymentSent"
        );

        // Check if the function caller is an externally owned account (EOA)
        require(msg.sender == tx.origin, "Caller must be an EOA");

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                msg.sender,
                maker,
                takerSecretHash,
                sha256(abi.encodePacked(makerSecret)),
                tokenAddress,
                tokenId,
                amount
            )
        );
        require(
            paymentHash == makerPayments[id].paymentHash,
            "Invalid paymentHash"
        );

        // Effects
        makerPayments[id].state = MakerPaymentState.TakerSpent;

        // Event Emission
        emit MakerPaymentSpent(id);

        // Interactions
        IERC1155 token = IERC1155(tokenAddress);
        token.safeTransferFrom(address(this), msg.sender, tokenId, amount, "");
    }

    function refundErc721MakerPaymentTimelock(
        bytes32 id,
        address taker,
        bytes32 takerSecretHash,
        bytes32 makerSecretHash,
        address tokenAddress,
        uint256 tokenId
    ) external {
        require(
            makerPayments[id].state == MakerPaymentState.PaymentSent,
            "Invalid payment state. Must be PaymentSent"
        );

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                taker,
                msg.sender,
                takerSecretHash,
                makerSecretHash,
                tokenAddress,
                tokenId
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

        IERC721 token = IERC721(tokenAddress);
        token.safeTransferFrom(address(this), msg.sender, tokenId);
    }

    function refundErc1155MakerPaymentTimelock(
        bytes32 id,
        uint256 amount,
        address taker,
        bytes32 takerSecretHash,
        bytes32 makerSecretHash,
        address tokenAddress,
        uint256 tokenId
    ) external {
        require(
            makerPayments[id].state == MakerPaymentState.PaymentSent,
            "Invalid payment state. Must be PaymentSent"
        );

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                taker,
                msg.sender,
                takerSecretHash,
                makerSecretHash,
                tokenAddress,
                tokenId,
                amount
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

        // Interactions
        IERC1155 token = IERC1155(tokenAddress);
        token.safeTransferFrom(address(this), msg.sender, tokenId, amount, "");
    }

    function refundErc721MakerPaymentSecret(
        bytes32 id,
        address taker,
        bytes32 takerSecret,
        bytes32 makerSecretHash,
        address tokenAddress,
        uint256 tokenId
    ) external {
        require(
            makerPayments[id].state == MakerPaymentState.PaymentSent,
            "Invalid payment state. Must be PaymentSent"
        );

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                taker,
                msg.sender,
                sha256(abi.encodePacked(takerSecret)),
                makerSecretHash,
                tokenAddress,
                tokenId
            )
        );

        require(
            paymentHash == makerPayments[id].paymentHash,
            "Invalid paymentHash"
        );

        makerPayments[id].state = MakerPaymentState.MakerRefunded;

        emit MakerPaymentRefundedSecret(id);

        IERC721 token = IERC721(tokenAddress);
        token.safeTransferFrom(address(this), msg.sender, tokenId);
    }

    function refundErc1155MakerPaymentSecret(
        bytes32 id,
        uint256 amount,
        address taker,
        bytes32 takerSecret,
        bytes32 makerSecretHash,
        address tokenAddress,
        uint256 tokenId
    ) external {
        require(
            makerPayments[id].state == MakerPaymentState.PaymentSent,
            "Invalid payment state. Must be PaymentSent"
        );

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                taker,
                msg.sender,
                sha256(abi.encodePacked(takerSecret)),
                makerSecretHash,
                tokenAddress,
                tokenId,
                amount
            )
        );

        require(
            paymentHash == makerPayments[id].paymentHash,
            "Invalid paymentHash"
        );

        makerPayments[id].state = MakerPaymentState.MakerRefunded;

        emit MakerPaymentRefundedSecret(id);

        IERC1155 token = IERC1155(tokenAddress);
        token.safeTransferFrom(address(this), msg.sender, tokenId, amount, "");
    }

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
                address(0)
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

    struct HTLCParams {
        bytes32 id;
        address taker;
        address tokenAddress;
        bytes32 takerSecretHash;
        bytes32 makerSecretHash;
        uint32 paymentLockTime;
    }

    function onERC1155Received(
        address operator,
        address from,
        uint256 tokenId,
        uint256 value,
        bytes calldata data
    ) external override returns (bytes4) {
        // Decode the data to extract HTLC parameters
        HTLCParams memory params = abi.decode(data, (HTLCParams));

        require(params.taker != address(0), "Taker must not be zero address");
        require(
            params.tokenAddress != address(0),
            "Token must not be zero address"
        );
        require(
            msg.sender == params.tokenAddress,
            "Token address does not match sender"
        );
        require(operator == from, "Operator must be the sender");
        require(value > 0, "Value must be greater than 0");
        require(
            makerPayments[params.id].state == MakerPaymentState.Uninitialized,
            "Maker ERC1155 payment must be Uninitialized"
        );
        require(!isContract(params.taker), "Taker cannot be a contract");

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                params.taker,
                from,
                params.takerSecretHash,
                params.makerSecretHash,
                params.tokenAddress,
                tokenId,
                value
            )
        );

        makerPayments[params.id] = MakerPayment(
            paymentHash,
            params.paymentLockTime,
            MakerPaymentState.PaymentSent
        );
        emit MakerPaymentSent(params.id);

        // Return this magic value to confirm receipt of ERC1155 token
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address, /* operator */
        address, /* from */
        uint256[] calldata, /* ids */
        uint256[] calldata, /* values */
        bytes calldata /* data */
    ) external pure override returns (bytes4) {
        revert("Batch transfers not supported");
    }

    function supportsInterface(bytes4 interfaceId)
    public
    view
    override(ERC165, IERC165)
    returns (bool)
    {
        return
            interfaceId == type(IERC1155Receiver).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    function onERC721Received(
        address operator,
        address from,
        uint256 tokenId,
        bytes calldata data
    ) external override returns (bytes4) {
        // Decode the data to extract HTLC parameters
        HTLCParams memory params = abi.decode(data, (HTLCParams));

        require(params.taker != address(0), "Taker must not be zero address");
        require(
            params.tokenAddress != address(0),
            "Token must not be zero address"
        );
        require(
            msg.sender == params.tokenAddress,
            "Token address does not match sender"
        );
        require(operator == from, "Operator must be the sender");
        require(
            makerPayments[params.id].state == MakerPaymentState.Uninitialized,
            "Maker ERC721 payment must be Uninitialized"
        );
        require(!isContract(params.taker), "Taker cannot be a contract");

        bytes20 paymentHash = ripemd160(
            abi.encodePacked(
                params.taker,
                from,
                params.takerSecretHash,
                params.makerSecretHash,
                params.tokenAddress,
                tokenId
            )
        );

        makerPayments[params.id] = MakerPayment(
            paymentHash,
            params.paymentLockTime,
            MakerPaymentState.PaymentSent
        );
        emit MakerPaymentSent(params.id);

        // Return this magic value to confirm receipt of ERC721 token
        return this.onERC721Received.selector;
    }

    function isContract(address account) internal view returns (bool) {
        uint256 size;
        assembly {
            size := extcodesize(account)
        }
        return size > 0;
    }
}
