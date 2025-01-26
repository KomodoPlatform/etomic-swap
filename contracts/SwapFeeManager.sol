// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract SwapFeeManager is Ownable {
    using SafeERC20 for IERC20;

    address public immutable dexFeeWallet;
    address public immutable burnFeeWallet;

    uint256 private constant BURN_FEE_PERCENT = 25;
    uint256 private constant TOTAL_PERCENT = 100;

    event FeesSplit(uint256 dexFeeAmount, uint256 burnFeeAmount);

    constructor(
        address _dexFeeWallet,
        address _burnFeeWallet
    ) Ownable(_msgSender()) {
        require(
            _dexFeeWallet != address(0),
            "dexFeeWallet must not be zero address"
        );
        require(
            _burnFeeWallet != address(0),
            "burnFeeWallet must not be zero address"
        );

        dexFeeWallet = _dexFeeWallet;
        burnFeeWallet = _burnFeeWallet;
    }

    // Function to receive Ether
    receive() external payable {}

    /**
     * @dev Splits the Ether balance in the contract into 75% for dexFeeWallet and 25% for burnFeeWallet.
     */
    function splitAndWithdraw() external onlyOwner {
        uint256 totalBalance = address(this).balance;
        require(totalBalance > 0, "No fees to split");

        uint256 burnFeeAmount = (totalBalance * BURN_FEE_PERCENT) /
            TOTAL_PERCENT;
        uint256 dexFeeAmount = totalBalance - burnFeeAmount;

        emit FeesSplit(dexFeeAmount, burnFeeAmount);

        payable(dexFeeWallet).transfer(dexFeeAmount);
        payable(burnFeeWallet).transfer(burnFeeAmount);
    }

    /**
     * @dev Splits and withdraws ERC20 token balance.
     * @param tokenAddress Address of the ERC20 token.
     */
    function splitAndWithdrawToken(address tokenAddress) external onlyOwner {
        require(tokenAddress != address(0), "Token address must not be zero");
        IERC20 token = IERC20(tokenAddress);

        uint256 totalBalance = token.balanceOf(address(this));
        require(totalBalance > 0, "No token fees to split");

        uint256 burnFeeAmount = (totalBalance * BURN_FEE_PERCENT) /
            TOTAL_PERCENT;
        uint256 dexFeeAmount = totalBalance - burnFeeAmount;

        emit FeesSplit(dexFeeAmount, burnFeeAmount);

        token.safeTransfer(dexFeeWallet, dexFeeAmount);
        token.safeTransfer(burnFeeWallet, burnFeeAmount);
    }
}
