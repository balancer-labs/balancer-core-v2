import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import { Contract, ContractReceipt } from 'ethers';
import { ethers } from 'hardhat';
import { deploy } from './deploy';

export const StandardPool = 0;
export const SimplifiedQuotePool = 1;
export const TwoTokenPool = 2;

export type PoolOptimizationSetting = typeof SimplifiedQuotePool | typeof StandardPool | typeof TwoTokenPool;
export type PoolName = 'ConstantProductPool' | 'StablecoinPool';

/**
 * Deploys a Pool via a Factory contract.
 *
 * @param vault The Vault contract.
 * @param admin The admin of the Vault.
 * @param poolName The name of the Pool contract. The factory must have the same name, with the 'Factory'
 * suffix.
 * @param args An object with the signer that will call the factory and the arguments for the Pool's constructor.
 */
export async function deployPoolFromFactory(
  vault: Contract,
  admin: SignerWithAddress,
  poolName: PoolName,
  args: { from: SignerWithAddress; parameters: Array<unknown> }
): Promise<Contract> {
  const factory = await deploy(`${poolName}Factory`, { args: [vault.address] });
  // We could reuse this factory if we saved it accross tokenizer deployments

  const name = 'Balancer Pool Token';
  const symbol = 'BPT';

  // Authorize factory so that created pool are universal agents
  await vault.connect(admin).addUniversalAgentManager(factory.address);

  const salt = ethers.utils.id(Math.random().toString());

  const receipt: ContractReceipt = await (
    await factory.connect(args.from).create(name, symbol, ...args.parameters, salt)
  ).wait();

  const event = receipt.events?.find((e) => e.event == 'PoolCreated');
  if (event == undefined) {
    throw new Error('Could not find PoolCreated event');
  }

  return ethers.getContractAt(poolName, event.args?.pool);
}
