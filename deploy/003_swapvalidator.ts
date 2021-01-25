import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, tenderly } = hre;
  const { deploy } = deployments;

  const { deployer } = await getNamedAccounts();

  const validatorscript = await deploy('OneToOneSwapValidator', {
    from: deployer,
    args: [],
    log: true,
    deterministicDeployment: true,
  });

  if (hre.network.live && validatorscript.newlyDeployed) {
    await tenderly.push({
      name: 'OneToOneSwapValidator',
      address: validatorscript.address,
    });
  }
};
export default func;
