const { ethers } = require("hardhat");

// to run execute `docker compose exec workspace npx hardhat run scripts/wastingGasWithAccessListExample.js` command
async function main() {
  const [user] = await ethers.getSigners();
  const data = "0x5197c7aa"; // function selector for the `getX` function
  const userAddress = await user.getAddress();
  console.log(`User address ${userAddress}`);

  const Slot = await ethers.getContractFactory("Wrong");
  const slot = await Slot.deploy();
  await slot.waitForDeployment();

  // Log the contract address correctly
  const slotAddress = await slot.getAddress();
  console.log(`Slot contract deployed to ${slotAddress}`);

  const badtx = {
    from: userAddress,
    to: slotAddress,
    data: data,
    value: 0,
    type: 1,
    accessList: [
      {
        address: slotAddress,
        storageKeys: [
          "0x0000000000000000000000000000000000000000000000000000000000000001", // wrong slot number
        ],
      },
    ],
  };

  console.log("==============  transaction with incorrect access list ==============");
  const badTxResult = await user.sendTransaction(badtx);
  const badTxReceipt = await badTxResult.wait();

  console.log(
    `gas cost for incorrect access list: ${badTxReceipt.gasUsed.toString()}`
  );

  const normaltx = {
    from: userAddress,
    to: slotAddress,
    data: data,
    value: 0,
  };

  console.log("==============  transaction without access list ==============");
  const normalTxResult = await user.sendTransaction(normaltx);
  const normalTxReceipt = await normalTxResult.wait();

  console.log(
    `gas cost for tx without access list: ${normalTxReceipt.gasUsed.toString()}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
