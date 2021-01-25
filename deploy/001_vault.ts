import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, tenderly } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const authorizer = await deployments.get('Authorizer');

  const vault = await deploy('Vault', {
    from: deployer,
    args: [authorizer.address],
    log: true,
    deterministicDeployment: true,
  });

  if (hre.network.live && vault.newlyDeployed) {
    await tenderly.push({
      name: 'Vault',
      address: vault.address,
    });
  }
};
export default func;
