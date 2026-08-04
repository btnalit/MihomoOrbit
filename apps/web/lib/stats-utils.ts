/**
 * Shared utility functions for stats tables (used by Proxies, Devices, Rules)
 */

// Chart color palette
export const COLORS = [
  "#3B82F6", "#8B5CF6", "#06B6D4", "#10B981", "#F59E0B",
  "#EF4444", "#EC4899", "#6366F1", "#14B8A6", "#F97316",
];

// Pagination options
export const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;
export type PageSize = typeof PAGE_SIZE_OPTIONS[number];

// Sort order type
export type SortOrder = "asc" | "desc";

// Domain sort keys
export type DomainSortKey = "domain" | "totalDownload" | "totalUpload" | "totalConnections";

// IP sort keys  
export type IPSortKey = "ip" | "totalDownload" | "totalUpload" | "totalConnections";

// Color palette for icons
export const ICON_COLORS = [
  { bg: "bg-blue-500", text: "text-white" },
  { bg: "bg-violet-500", text: "text-white" },
  { bg: "bg-emerald-500", text: "text-white" },
  { bg: "bg-amber-500", text: "text-white" },
  { bg: "bg-rose-500", text: "text-white" },
  { bg: "bg-cyan-500", text: "text-white" },
  { bg: "bg-indigo-500", text: "text-white" },
  { bg: "bg-teal-500", text: "text-white" },
];

/**
 * Generate gradient class for IP address display
 */
export function getIPGradient(ip: string): string {
  const gradients = [
    "from-blue-500 to-cyan-400",
    "from-violet-500 to-purple-400",
    "from-emerald-500 to-teal-400",
    "from-amber-500 to-orange-400",
    "from-rose-500 to-pink-400",
    "from-indigo-500 to-blue-400",
  ];
  let hash = 0;
  for (let i = 0; i < ip.length; i++) {
    hash = ip.charCodeAt(i) + ((hash << 5) - hash);
  }
  return gradients[Math.abs(hash) % gradients.length];
}

/**
 * Get color for domain icon
 */
export function getDomainColor(domain: string) {
  let hash = 0;
  for (let i = 0; i < domain.length; i++) {
    hash = domain.charCodeAt(i) + ((hash << 5) - hash);
  }
  return ICON_COLORS[Math.abs(hash) % ICON_COLORS.length];
}

/**
 * Get color for IP icon
 */
export function getIPColor(ip: string) {
  let hash = 0;
  for (let i = 0; i < ip.length; i++) {
    hash = ip.charCodeAt(i) + ((hash << 5) - hash);
  }
  return ICON_COLORS[Math.abs(hash) % ICON_COLORS.length];
}

/**
 * Generate pagination page numbers with ellipsis
 */
export function getPageNumbers(currentPage: number, totalPages: number): (number | "...")[] {
  const pages: (number | "...")[] = [];
  if (totalPages <= 5) {
    for (let i = 1; i <= totalPages; i++) pages.push(i);
  } else {
    if (currentPage <= 3) {
      pages.push(1, 2, 3, 4, "...", totalPages);
    } else if (currentPage >= totalPages - 2) {
      pages.push(1, "...", totalPages - 3, totalPages - 2, totalPages - 1, totalPages);
    } else {
      pages.push(1, "...", currentPage - 1, currentPage, currentPage + 1, "...", totalPages);
    }
  }
  return pages;
}
