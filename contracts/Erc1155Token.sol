// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;
import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract Erc1155Token is ERC1155, Ownable  {
    constructor(string memory tokenUri) ERC1155(tokenUri) Ownable(msg.sender) {
        uint256 tokenId = 1;
        uint256 amount = 3;
        _mint(msg.sender, tokenId, amount, "");
    }

    // Public mint function
    function mint(address to, uint256 tokenId, uint256 amount, bytes memory data) public onlyOwner {
        _mint(to, tokenId, amount, data);
    }
}
