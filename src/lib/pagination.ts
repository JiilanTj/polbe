/**
 * Parse pagination query params dengan safe defaults.
 */
export function parsePagination(query: Record<string, string | undefined>) {
  const page = Math.max(1, parseInt(query["page"] || "1") || 1);
  const limit = Math.min(Math.max(1, parseInt(query["limit"] || "20") || 20), 100);
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

/**
 * Bungkus data + pagination meta jadi response standar.
 */
export function paginatedResponse<T>(data: T[], total: number, page: number, limit: number) {
  return {
    data,
    pagination: {
      total: Number(total),
      page,
      limit,
      totalPages: Math.ceil(Number(total) / limit),
    },
  };
}
