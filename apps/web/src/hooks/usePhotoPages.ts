import { useInfiniteQuery } from '@tanstack/react-query';
import type { Page, PhotoSummary } from '../api/types';

const PAGE = 60;

/** Offset-paginated photo list with "load more". */
export function usePhotoPages(key: readonly unknown[], fetchPage: (offset: number, limit: number) => Promise<Page<PhotoSummary>>) {
  const q = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => fetchPage(pageParam, PAGE),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.offset + last.items.length < last.total ? last.offset + last.items.length : undefined),
  });
  const photos = q.data?.pages.flatMap((p) => p.items) ?? [];
  const total = q.data?.pages[0]?.total ?? 0;
  return { ...q, photos, total };
}
