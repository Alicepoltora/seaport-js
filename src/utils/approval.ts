import type { ethers, Signer } from "ethers"
import { ItemType, MAX_INT } from "../constants"
import {
  TestERC20__factory,
  TestERC721__factory,
} from "../typechain-types/index"
import type { ApprovalAction, Item } from "../types"
import type { InsufficientApprovals } from "./balanceAndApprovalCheck"
import { isCriteriaItem, isErc721Item, isErc1155Item } from "./item"
import { getTransactionMethods } from "./usecase"

export const approvedItemAmount = async (
  owner: string,
  item: Item,
  operator: string,
  provider: ethers.Provider,
) => {
  if (isErc721Item(item.itemType) || isErc1155Item(item.itemType)) {
    // isApprovedForAll check is the same for both ERC721 and ERC1155, defaulting to ERC721
    const contract = TestERC721__factory.connect(item.token, provider)

    const isApprovedForAll = await contract.isApprovedForAll(owner, operator)
    // Setting to the max int to consolidate types and simplify
    return isApprovedForAll ? MAX_INT : 0n
  } else if (item.itemType === ItemType.ERC20) {
    const contract = TestERC20__factory.connect(item.token, provider)

    return contract.allowance(owner, operator)
  }

  // We don't need to check approvals for native tokens
  return MAX_INT
}

export const getApprovalDedupKey = (
  approval: {
    token: string
    operator: string
    itemType: ItemType
    identifierOrCriteria: string
  },
  exactApproval: boolean,
): string => {
  const token = approval.token.toLowerCase()
  const operator = approval.operator.toLowerCase()

  if (canApproveSingleToken(approval.itemType, exactApproval)) {
    return `${token}:${operator}:${approval.identifierOrCriteria}`
  }

  return `${token}:${operator}`
}

/**
 * Whether an item can be covered by approving one token id rather than the
 * whole collection.
 *
 * Only a non-criteria ERC721 can. ERC1155 has no per-id approval. A criteria
 * item names a set of ids, and the fulfiller chooses which one at fulfillment
 * time, so no single id covers it -- and when no criteria are resolved,
 * identifierOrCriteria is the merkle root rather than an id at all, which makes
 * `approve` revert outright.
 *
 * Shared by getApprovalDedupKey and getApprovalActions so that the key an
 * approval is deduped under always matches the call that approval will make.
 */
const canApproveSingleToken = (itemType: ItemType, exactApproval: boolean) =>
  exactApproval && isErc721Item(itemType) && !isCriteriaItem(itemType)

/**
 * Get approval actions given a list of insufficient approvals.
 */
export function getApprovalActions(
  insufficientApprovals: InsufficientApprovals,
  exactApproval: boolean,
  signer: Signer,
): ApprovalAction[] {
  const seenApprovalKeys = new Set<string>()

  return [...insufficientApprovals]
    .reverse()
    .filter(approval => {
      const key = getApprovalDedupKey(approval, exactApproval)

      if (seenApprovalKeys.has(key)) {
        return false
      }

      seenApprovalKeys.add(key)
      return true
    })
    .reverse()
    .map(
      ({
        token,
        operator,
        itemType,
        identifierOrCriteria,
        requiredApprovedAmount,
      }) => {
        if (isErc721Item(itemType) || isErc1155Item(itemType)) {
          // setApprovalForAll check is the same for both ERC721 and ERC1155, defaulting to ERC721
          const contract = TestERC721__factory.connect(token, signer)
          const transactionMethods = canApproveSingleToken(
            itemType,
            exactApproval,
          )
            ? getTransactionMethods(signer, contract, "approve", [
                operator,
                identifierOrCriteria,
              ])
            : getTransactionMethods(signer, contract, "setApprovalForAll", [
                operator,
                true,
              ])

          return {
            type: "approval",
            token,
            identifierOrCriteria,
            itemType,
            operator,
            transactionMethods,
          }
        } else {
          const contract = TestERC20__factory.connect(token, signer)

          return {
            type: "approval",
            token,
            identifierOrCriteria,
            itemType,
            transactionMethods: getTransactionMethods(
              signer,
              contract,
              "approve",
              [operator, exactApproval ? requiredApprovedAmount : MAX_INT],
            ),
            operator,
          }
        }
      },
    )
}
