import type { GatewayProvidersResponse, GatewayRulesResponse, GatewayProxiesResponse } from "./api";
import { parseGatewayRule } from "@neko-master/shared";

export function encodeActiveLinkKey(sourceName: string, targetName: string): string {
  return JSON.stringify([sourceName, targetName]);
}

export interface ActiveChainInfo {
  /** Set of node names that are part of active chains */
  activeNodeNames: Set<string>;
  /** Set of encoded [sourceName, targetName] keys for active links */
  activeLinkKeys: Set<string>;
  /** Map from proxy group name to its full active chain path */
  activeChains: Map<string, string[]>;
}

/**
 * Build a map of group name → currently selected proxy/group name
 * from the providers/proxies response.
 */
function buildGroupNowMap(
  providers: GatewayProvidersResponse,
  proxies?: GatewayProxiesResponse
): Map<string, string> {
  const map = new Map<string, string>();
  
  // 1. Add groups from Providers
  for (const provider of Object.values(providers.providers)) {
    if (!provider.proxies) continue;
    for (const proxy of provider.proxies) {
      if (proxy.now) {
        map.set(proxy.name, proxy.now);
      }
    }
  }

  // 2. Add top-level groups from Proxies (Surge/Clash global proxies)
  if (proxies?.proxies) {
    for (const proxy of Object.values(proxies.proxies)) {
      if (proxy.now) {
        map.set(proxy.name, proxy.now);
      }
    }
  }
  return map;
}

/**
 * Follow the active proxy chain from a starting group name.
 * Returns the full path including the starting group.
 */
function followChain(startGroup: string, groupNowMap: Map<string, string>): string[] {
  const path: string[] = [startGroup];
  const visited = new Set<string>();
  visited.add(startGroup);

  let current = startGroup;
  while (groupNowMap.has(current)) {
    const next = groupNowMap.get(current)!;
    if (visited.has(next)) break; // prevent cycles
    visited.add(next);
    path.push(next);
    current = next;
  }
  return path;
}

/**
 * Resolve active policy chains from Gateway providers and rules data.
 */
export function resolveActiveChains(
  providers: GatewayProvidersResponse,
  rules: GatewayRulesResponse,
  proxies?: GatewayProxiesResponse
): ActiveChainInfo {
  // Use the global proxy list (from /gateway/proxies) as the primary source for 'now'
  // because it contains the accurate 'now' field we fetched from the backend.
  const groupNowMap = buildGroupNowMap(providers, proxies);
  
  const activeNodeNames = new Set<string>();
  const activeLinkKeys = new Set<string>();
  const activeChains = new Map<string, string[]>();

  // Helper to process a chain
  const processChainRecursive = (startNode: string) => {
      if (activeChains.has(startNode)) return activeChains.get(startNode)!;
      
      const chain = followChain(startNode, groupNowMap);
      activeChains.set(startNode, chain);
      
      // Mark nodes and links as active
      for (const name of chain) {
        activeNodeNames.add(name);
      }
      for (let i = 0; i < chain.length - 1; i++) {
        activeLinkKeys.add(encodeActiveLinkKey(chain[i], chain[i + 1]));
      }
      return chain;
  };

  // 1. First pass: Resolve chains for all groups in the groupNowMap
  // This ensures that even groups not referenced by rules directly (but part of a chain) are resolved?
  // Actually, we only need to resolve starting from Rules or known start points.
  
  // 2. Process all rules
  if (rules && rules.rules) {
      for (const rawRule of rules.rules) {
        const parsed = parseGatewayRule(rawRule);
        if (!parsed || !parsed.proxy) continue;

        const targetGroup = parsed.proxy;
        
        // Resolve the chain for the Target Group of this rule
        const groupChain = processChainRecursive(targetGroup);

        const ruleName = parsed.payload; 
        
        // Map Rule -> Group -> [Rest of Chain]
        // Note: For "FINAL" rules, ruleName might be empty or "FINAL". 
        // In the UI, the rule node ID is usually the payload or normalized string.
        
        if (ruleName) {
            const ruleChain = [ruleName, ...groupChain];
            activeChains.set(ruleName, ruleChain);
            
            activeNodeNames.add(ruleName);
            if (groupChain.length > 0) {
               activeLinkKeys.add(encodeActiveLinkKey(ruleName, groupChain[0]));
            }
        }
      }
  }

  return { activeNodeNames, activeLinkKeys, activeChains };
}
