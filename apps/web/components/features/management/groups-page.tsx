"use client";

/**
 * Proxy groups management page (M1 task 5). Card grid over
 * `useManagementGroups`; per-card member expansion, click-to-select with an
 * optimistic `now` update, and a group delay test button whose results
 * stream in over the `delay` topic (see m1-contracts.md).
 *
 * GLOBAL is sorted last (zashboard precedent — it's the noisiest group,
 * containing every proxy) and, like every other card, starts collapsed —
 * satisfying the brief's "render it last OR collapsed by default" with one
 * mechanism instead of a GLOBAL-specific special case.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Network, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { apiErrorCode, isUnreachableError, type ManagementGroupsResponse } from "@/lib/api";
import {
  managementGroupsQueryKey,
  useGroupDelayTest,
  useManagementGroups,
  useSelectProxy,
} from "@/hooks/api/use-management";
import { useTopicSubscription, type TopicMessage } from "@/lib/management-ws";
import { GroupCard } from "./group-card";
import type { DelayValue } from "./delay-badge";

const GLOBAL_GROUP_NAME = "GLOBAL";
const SELECT_ERROR_DISPLAY_MS = 3000;

interface DelayDoneData {
  group: string;
  done: true;
}

interface DelayResultData {
  group: string;
  proxy: string;
  delay?: number;
  error?: string;
}

type DelayTopicData = DelayDoneData | DelayResultData;

interface GroupsPageProps {
  backendId: number | undefined;
}

export function GroupsPage({ backendId }: GroupsPageProps) {
  const t = useTranslations("management.groups");
  const queryClient = useQueryClient();

  const groupsQuery = useManagementGroups(backendId);
  const selectProxy = useSelectProxy(backendId);
  const groupDelayTest = useGroupDelayTest(backendId);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [testingGroups, setTestingGroups] = useState<Set<string>>(new Set());
  const [overrideDelays, setOverrideDelays] = useState<Map<string, DelayValue>>(new Map());
  const [topicOffline, setTopicOffline] = useState(false);
  const [selectError, setSelectError] = useState<{ group: string; proxy: string } | null>(null);
  const selectErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (selectErrorTimerRef.current) clearTimeout(selectErrorTimerRef.current);
    };
  }, []);

  // `delay` is an append topic (m1-contracts.md) — frames only arrive during
  // an active test, so a `topic-error` can't be self-healed by waiting for
  // another `topic` data frame that may never come. A successful REST fetch
  // proves the backend answered, so clear the flag on that signal instead.
  // Triggers the same `react-hooks/set-state-in-effect` lint finding already
  // present and unfixed in `lib/websocket.ts` / `lib/management-ws.ts` for
  // the equivalent pattern — non-blocking (`lint-web` runs with
  // `continue-on-error: true` in CI for exactly this class of finding, per
  // task-4-report.md); a ref-guarded during-render alternative was tried
  // first but tripped the stricter `react-hooks/refs` rule instead.
  useEffect(() => {
    if (groupsQuery.isSuccess) {
      setTopicOffline(false);
    }
  }, [groupsQuery.isSuccess, groupsQuery.dataUpdatedAt]);

  const handleTopicMessage = useCallback((message: TopicMessage) => {
    if (message.type === "topic-error") {
      setTopicOffline(true);
      // The channel that would have delivered results just died — don't
      // strand any in-flight group in a spinner it can never resolve out of.
      setTestingGroups(new Set());
      return;
    }
    if (message.type === "topic-gap") {
      return;
    }

    const data = message.data as DelayTopicData;
    if (!data || typeof data !== "object") return;

    if ("done" in data) {
      setTestingGroups((prev) => {
        if (!prev.has(data.group)) return prev;
        const next = new Set(prev);
        next.delete(data.group);
        return next;
      });
      return;
    }

    if (data.proxy) {
      setOverrideDelays((prev) => {
        const next = new Map(prev);
        if (data.error) {
          next.set(data.proxy, "timeout");
        } else if (typeof data.delay === "number") {
          next.set(data.proxy, data.delay);
        }
        return next;
      });
    }
  }, []);

  useTopicSubscription({
    topic: "delay",
    backendId,
    enabled: backendId !== undefined,
    onMessage: handleTopicMessage,
  });

  const handleToggleExpand = useCallback((name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const handleSelectProxy = useCallback(
    (group: string, proxy: string) => {
      const queryKey = managementGroupsQueryKey(backendId);
      const prevNow = queryClient
        .getQueryData<ManagementGroupsResponse>(queryKey)
        ?.groups.find((g) => g.name === group)?.now;

      queryClient.setQueryData<ManagementGroupsResponse>(queryKey, (old) => {
        if (!old) return old;
        return {
          ...old,
          groups: old.groups.map((g) => (g.name === group ? { ...g, now: proxy } : g)),
        };
      });

      selectProxy.mutate(
        { group, proxy },
        {
          // Roll back only this group's `now`, and only if it still holds
          // THIS call's optimistic write. Other member buttons stay enabled
          // during flight, so a second, faster selection in the same group
          // can land (and be server-confirmed) before this one fails — in
          // that case the cache already reflects newer truth than `prevNow`
          // and a blind rollback would silently diverge from the server.
          // Re-sync from the server instead of guessing which value is
          // right (there's no polling here to self-heal a wrong guess).
          onError: () => {
            const liveNow = queryClient
              .getQueryData<ManagementGroupsResponse>(queryKey)
              ?.groups.find((g) => g.name === group)?.now;
            if (liveNow === proxy) {
              queryClient.setQueryData<ManagementGroupsResponse>(queryKey, (old) => {
                if (!old) return old;
                return {
                  ...old,
                  groups: old.groups.map((g) => (g.name === group ? { ...g, now: prevNow } : g)),
                };
              });
            } else {
              queryClient.invalidateQueries({ queryKey });
            }
            if (selectErrorTimerRef.current) clearTimeout(selectErrorTimerRef.current);
            setSelectError({ group, proxy });
            selectErrorTimerRef.current = setTimeout(
              () => setSelectError(null),
              SELECT_ERROR_DISPLAY_MS,
            );
          },
        },
      );
    },
    [backendId, queryClient, selectProxy],
  );

  const handleTestGroup = useCallback(
    (group: string) => {
      setTestingGroups((prev) => new Set(prev).add(group));
      groupDelayTest.mutate(
        { group },
        {
          onError: (error) => {
            // A 409 DELAY_TEST_RUNNING means a test IS actually running
            // server-side (started by this client or another) — its delay
            // frames and eventual `done` will still arrive over the topic.
            // Clearing the pending affordance here would be misleading; let
            // the topic's own `done` handling clear it instead.
            if (apiErrorCode(error) === "DELAY_TEST_RUNNING") return;
            setTestingGroups((prev) => {
              if (!prev.has(group)) return prev;
              const next = new Set(prev);
              next.delete(group);
              return next;
            });
          },
        },
      );
    },
    [groupDelayTest],
  );

  const handleRetry = useCallback(() => {
    groupsQuery.refetch();
  }, [groupsQuery]);

  const groupsUnreachable = groupsQuery.isError && isUnreachableError(groupsQuery.error);
  const offline = groupsUnreachable || topicOffline;
  const hasData = !!groupsQuery.data;

  if (groupsQuery.isLoading) {
    return <GroupsPageSkeleton />;
  }

  // Any other query error (not the documented unreachable-backend shape) —
  // rare in practice since ManagementGate already filters out the 404/409
  // cases, but don't render nothing if it happens.
  if (groupsQuery.isError && !groupsUnreachable && !hasData) {
    return (
      <div
        role="alert"
        className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 flex items-start gap-3"
      >
        <AlertTriangle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-destructive">{t("loadError")}</p>
          <p className="text-[13px] text-muted-foreground mt-0.5 break-words">
            {(groupsQuery.error as Error)?.message}
          </p>
        </div>
      </div>
    );
  }

  if (offline && !hasData) {
    return <OfflineBanner onRetry={handleRetry} retrying={groupsQuery.isRefetching} fullPage />;
  }

  const groups = groupsQuery.data?.groups ?? [];
  const proxies = groupsQuery.data?.proxies ?? {};

  const sortedGroups = [...groups].sort((a, b) => {
    if (a.name === GLOBAL_GROUP_NAME) return 1;
    if (b.name === GLOBAL_GROUP_NAME) return -1;
    return 0;
  });

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold flex items-center gap-2">
        <Network className="w-5 h-5" />
        {t("title")}
      </h2>

      {offline && <OfflineBanner onRetry={handleRetry} retrying={groupsQuery.isRefetching} />}

      {sortedGroups.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center text-muted-foreground">
            {t("empty")}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {sortedGroups.map((group) => (
            <GroupCard
              key={group.name}
              group={group}
              proxies={proxies}
              overrideDelays={overrideDelays}
              expanded={expanded.has(group.name)}
              onToggleExpand={() => handleToggleExpand(group.name)}
              testing={testingGroups.has(group.name)}
              onTestGroup={() => handleTestGroup(group.name)}
              onSelectProxy={(proxy) => handleSelectProxy(group.name, proxy)}
              selectFailedProxy={selectError?.group === group.name ? selectError.proxy : null}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function OfflineBanner({
  onRetry,
  retrying,
  fullPage,
}: {
  onRetry: () => void;
  retrying?: boolean;
  fullPage?: boolean;
}) {
  const t = useTranslations("management.groups");

  const content = (
    <div
      role="alert"
      className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 flex flex-wrap items-center justify-between gap-3"
    >
      <div className="flex items-center gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0" />
        <p className="text-sm text-amber-700 dark:text-amber-300">{t("offlineBanner")}</p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onRetry}
        disabled={retrying}
        className="gap-1.5"
      >
        <RefreshCw className={cn("w-3.5 h-3.5", retrying && "animate-spin")} />
        {t("retry")}
      </Button>
    </div>
  );

  if (!fullPage) return content;

  return <div className="flex items-center justify-center min-h-[50vh] p-4">{content}</div>;
}

function GroupsPageSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="rounded-xl border bg-card p-4 space-y-3">
          <div className="h-4 w-24 rounded bg-muted/60 animate-pulse" />
          <div className="h-3 w-32 rounded bg-muted/50 animate-pulse" />
          <div className="h-8 w-full rounded bg-muted/40 animate-pulse" />
        </div>
      ))}
    </div>
  );
}
