// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract Erc721Token is ERC721 {
    constructor(string memory tokenName, string memory tokenSymbol)
    ERC721(tokenName, tokenSymbol)
    {
        uint256 tokenId = 1;
        _mint(msg.sender, tokenId);
    }
}
