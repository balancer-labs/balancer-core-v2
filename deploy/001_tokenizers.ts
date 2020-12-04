import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from 'hardhat-deploy/types';

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getChainId, getNamedAccounts } = hre;
  const { deploy, execute } = deployments;

  const { deployer } = await getNamedAccounts();

  const chainId = await getChainId();

  const vault = await deployments.get('Vault');

  const fixedSetFactory = await deploy('FixedSetPoolTokenizerFactory', {
    from: deployer,
    args: [vault.address],
    log: true,
    deterministicDeployment: true,
  });

  const ownableFixedSetFactory = await deploy('OwnableFixedSetPoolTokenizerFactory', {
    from: deployer,
    args: [vault.address],
    log: true,
    deterministicDeployment: true,
  });

  if (fixedSetFactory.newlyDeployed && chainId != '31337') {
    await execute(
      'Vault',
      {
        from: deployer,
        log: true,
      },
      'authorizeTrustedOperatorReporter',
      fixedSetFactory.address
    );
  }

  if (ownableFixedSetFactory.newlyDeployed && chainId != '31337') {
    await execute(
      'Vault',
      {
        from: deployer,
        log: true,
      },
      'authorizeTrustedOperatorReporter',
      ownableFixedSetFactory.address
    );
  }
};
export default func;
