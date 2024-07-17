const { ethers } = require("hardhat");

// to run execute `docker compose exec workspace npx hardhat run scripts/accessListExample.js` command
async function main() {
  const [user] = await ethers.getSigners();
  const data = "0xf4acc7b5"; // function selector for `callCalculator()`
  const userAddress = await user.getAddress();
  console.log(`User address ${userAddress}`);

  const Calculator = await ethers.getContractFactory("Calculator");
  const calculator = await Calculator.deploy();
  await calculator.waitForDeployment();

  // Log the contract address correctly
  const calculatorAddress = await calculator.getAddress();
  console.log(`Calc contract deployed to ${calculatorAddress}`);

  const Caller = await ethers.getContractFactory("Caller");
  const caller = await Caller.deploy(calculatorAddress); // Use calculatorAddress here
  await caller.waitForDeployment();

  // Log the caller address correctly
  const callerAddress = await caller.getAddress();
  console.log(`Caller contract deployed to ${callerAddress}`);

  const tx1 = {
    from: userAddress,
    to: callerAddress,
    data: data,
    value: 0,
    type: 1,
    accessList: [
      {
        address: calculatorAddress,
        storageKeys: [
          "0x0000000000000000000000000000000000000000000000000000000000000000",
          "0x0000000000000000000000000000000000000000000000000000000000000001",
        ],
      },
    ],
  };

  const tx2 = {
    from: userAddress,
    to: callerAddress,
    data: data,
    value: 0,
  };

  console.log("==============  transaction with access list ==============");
  const txCall = await user.sendTransaction(tx1);

  const receipt = await txCall.wait();

  console.log(
    `gas cost for tx with access list: ${receipt.gasUsed.toString()}`
  );

  console.log("==============  transaction without access list ==============");
  const txCallNA = await user.sendTransaction(tx2);

  const receiptNA = await txCallNA.wait();

  console.log(
    `gas cost for tx without access list: ${receiptNA.gasUsed.toString()}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
