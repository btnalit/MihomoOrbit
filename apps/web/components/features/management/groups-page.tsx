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
 *
 * M1.5 polish item ②: `hidden: true` groups (config-declared, e.g. helper
 * selectors a user doesn't want cluttering the dashboard) are filtered out
 * by default; `showHidden` toggles them back in. Page-local `useState`
 * only — no persistence (no localStorage per the plan's red lines), so it
 * resets on every reload/backend switch same as the rest of this page's
 * local state.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Network, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
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
// Per-group watchdog (finding 5, M1 final-review fix wave): a lost `done`
// frame — delay socket reconnecting mid-test, a click that raced onopen, or
// an append-queue overflow dropping the frame — would otherwise strand a
// group in `testingGroups` forever, since nothing else ever clears it.
const TESTING_GROUP_STALE_MS = 30000;
const TESTING_GROUP_WATCHDOG_INTERVAL_MS = 1000;

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
  // Polish item ②: filter ON by default (hidden groups start hidden).
  const [showHidden, setShowHidden] = useState(false);
  const [testingGroups, setTestingGroups] = useState<Set<string>>(new Set());
  const [overrideDelays, setOverrideDelays] = useState<Map<string, DelayValue>>(new Map());
  const [topicOffline, setTopicOffline] = useState(false);
  const [selectError, setSelectError] = useState<{ group: string; proxy: string } | null>(null);
  const selectErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Per-group monotonic selection token. Ownership of a group's rollback is
  // judged by RECENCY (this call was still the latest attempt when it
  // failed), never by comparing the cached `now` value — two attempts for
  // the same proxy (P1 -> P2 -> P1) can otherwise coincide on value even
  // though the first P1 call is stale by the time it fails. Lives inside
  // GroupsPage so the dispatch's `key={activeBackendId}` remount resets it
  // along with everything else on a backend switch.
  const selectSeqRef = useRef<Map<string, number>>(new Map());
  // Last time ANY delay-topic frame (result or done) was observed for a
  // given testing group — the watchdog below clears a group whose entry
  // goes stale. Set the moment a test starts too, so a group that receives
  // no frames at all (not even one member result) is still bounded.
  const lastFrameAtRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    return () => {
      if (selectErrorTimerRef.current) clearTimeout(selectErrorTimerRef.current);
    };
  }, []);

  // Watchdog: runs for the component's whole lifetime (not re-created per
  // testingGroups change) and reads/writes state only through the
  // functional setState form + the ref above, so it never closes over stale
  // `testingGroups`.
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setTestingGroups((prev) => {
        if (prev.size === 0) return prev;
        let next: Set<string> | null = null;
        for (const group of prev) {
          const lastFrameAt = lastFrameAtRef.current.get(group);
          if (lastFrameAt === undefined || now - lastFrameAt > TESTING_GROUP_STALE_MS) {
            if (!next) next = new Set(prev);
            next.delete(group);
            lastFrameAtRef.current.delete(group);
          }
        }
        return next ?? prev;
      });
    }, TESTING_GROUP_WATCHDOG_INTERVAL_MS);
    return () => clearInterval(interval);
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
      lastFrameAtRef.current.clear();
      return;
    }
    if (message.type === "topic-gap") {
      return;
    }

    const data = message.data as DelayTopicData;
    if (!data || typeof data !== "object") return;

    // Any frame for this group — a per-member result or the trailing done —
    // proves the channel is still delivering for it, so it resets the
    // group's watchdog clock regardless of which branch handles it below.
    if (data.group) {
      lastFrameAtRef.current.set(data.group, Date.now());
    }

    if ("done" in data) {
      setTestingGroups((prev) => {
        if (!prev.has(data.group)) return prev;
        const next = new Set(prev);
        next.delete(data.group);
        return next;
      });
      lastFrameAtRef.current.delete(data.group);
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

  const { status: delayWsStatus } = useTopicSubscription({
    topic: "delay",
    backendId,
    enabled: backendId !== undefined,
    onMessage: handleTopicMessage,
  });

  // Any transition away from 'connected' (reconnecting, disconnected, error)
  // means results for whatever was in flight are lost — the socket that
  // would deliver them no longer exists, so a group left in `testingGroups`
  // through a reconnect would otherwise hang until the 30s watchdog above
  // (or forever, if it never reconnects in time). Mirrors the topic-error
  // clear above but for the "connection itself dropped" case rather than an
  // explicit server-side error frame.
  useEffect(() => {
    if (delayWsStatus === "connected") return;
    setTestingGroups((prev) => (prev.size === 0 ? prev : new Set()));
    lastFrameAtRef.current.clear();
  }, [delayWsStatus]);

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

      // Claim this group's latest-attempt token before firing the mutation.
      // Only the call that still owns the token when it fails is allowed to
      // roll back — a later click on the same group (even to the same
      // proxy, e.g. P1 -> P2 -> P1) bumps the token and disowns this one.
      const seq = (selectSeqRef.current.get(group) ?? 0) + 1;
      selectSeqRef.current.set(group, seq);

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
          // Roll back only if THIS call is still the group's latest
          // attempt. Other member buttons stay enabled during flight, so a
          // later selection (possibly for the same proxy, coinciding on
          // value) can land and be server-confirmed before this older call
          // fails — comparing the cached `now` value can't tell those apart
          // from a genuinely-stale write, only recency can. When this call
          // isn't the latest, don't touch the cache at all: re-sync from
          // the server instead of guessing.
          onError: () => {
            if (selectSeqRef.current.get(group) === seq) {
              queryClient.setQueryData<ManagementGroupsResponse>(queryKey, (old) => {
                if (!old) return old;
                return {
                  ...old,
                  groups: old.groups.map((g) => (g.name === group ? { ...g, now: prevNow } : g)),
                };
              });
              if (selectErrorTimerRef.current) clearTimeout(selectErrorTimerRef.current);
              setSelectError({ group, proxy });
              selectErrorTimerRef.current = setTimeout(
                () => setSelectError(null),
                SELECT_ERROR_DISPLAY_MS,
              );
            } else {
              // A newer attempt owns this group's state now — its own
              // success/failure handling is responsible for the cache and
              // for any inline error; surfacing this stale failure too
              // would misattribute it to the wrong (newer) selection.
              queryClient.invalidateQueries({ queryKey });
            }
          },
        },
      );
    },
    [backendId, queryClient, selectProxy],
  );

  const handleTestGroup = useCallback(
    (group: string) => {
      // Start the watchdog clock now — a test that never receives a single
      // delay-topic frame (not even one member result) must still be bounded.
      lastFrameAtRef.current.set(group, Date.now());
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
            lastFrameAtRef.current.delete(group);
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
  const groupsUnauthorized =
    groupsQuery.isError && apiErrorCode(groupsQuery.error) === "UPSTREAM_UNAUTHORIZED";
  const offline = groupsUnreachable || topicOffline;
  const showOfflineBanner = offline || groupsUnauthorized;
  const hasData = !!groupsQuery.data;

  if (groupsQuery.isLoading) {
    return <GroupsPageSkeleton />;
  }

  // Any other query error (not the documented unreachable-backend shape, and
  // not the upstream-rejected-credentials shape handled below) — rare in
  // practice since ManagementGate already filters out the 404/409 cases, but
  // don't render nothing if it happens.
  if (groupsQuery.isError && !showOfflineBanner && !hasData) {
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

  if (showOfflineBanner && !hasData) {
    return (
      <OfflineBanner
        onRetry={handleRetry}
        retrying={groupsQuery.isRefetching}
        unauthorized={groupsUnauthorized}
        fullPage
      />
    );
  }

  const groups = groupsQuery.data?.groups ?? [];
  const proxies = groupsQuery.data?.proxies ?? {};

  // Display-only reorder: the REST response itself already orders GLOBAL
  // first (management.service.ts's fetchGroups — contract order, stable for
  // API consumers). This re-sort is purely local to this page's rendering
  // and moves GLOBAL last for the dashboard UX (zashboard precedent, see
  // file header comment); it never mutates the query cache, so any other
  // consumer of `groupsQuery.data` still sees the contract order.
  const sortedGroups = [...groups].sort((a, b) => {
    if (a.name === GLOBAL_GROUP_NAME) return 1;
    if (b.name === GLOBAL_GROUP_NAME) return -1;
    return 0;
  });

  // Polish item ②: hidden-group filter, applied after the contract-order
  // sort above so it never disturbs GLOBAL's placement — just removes
  // entries from the already-ordered list. Toggle is always rendered
  // (not conditioned on whether any group is currently hidden) — its
  // absence would itself look like a missing control on backends the user
  // hasn't yet configured any hidden groups on.
  const visibleGroups = showHidden ? sortedGroups : sortedGroups.filter((g) => !g.hidden);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Network className="w-5 h-5" />
          {t("title")}
        </h2>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch checked={showHidden} onCheckedChange={setShowHidden} aria-label={t("showHidden")} />
          {t("showHidden")}
        </label>
      </div>

      {showOfflineBanner && (
        <OfflineBanner
          onRetry={handleRetry}
          retrying={groupsQuery.isRefetching}
          unauthorized={groupsUnauthorized}
        />
      )}

      {visibleGroups.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center text-muted-foreground">
            <Network className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p className="font-medium">{t("empty")}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visibleGroups.map((group) => (
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
  unauthorized,
}: {
  onRetry: () => void;
  retrying?: boolean;
  fullPage?: boolean;
  /** Upstream answered but rejected the api_secret (UPSTREAM_UNAUTHORIZED) —
   *  same banner shell, different message than the generic offline case. */
  unauthorized?: boolean;
}) {
  const t = useTranslations("management.groups");
  const mt = useTranslations("management");

  const content = (
    <div
      role="alert"
      className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 flex flex-wrap items-center justify-between gap-3"
    >
      <div className="flex items-center gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0" />
        <p className="text-sm text-amber-700 dark:text-amber-300">
          {unauthorized ? mt("upstreamUnauthorized") : t("offlineBanner")}
        </p>
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
        <div key={i} className="rounded-xl border bg-card shadow-xs p-4 space-y-3">
          <div className="h-4 w-24 rounded bg-muted/60 animate-pulse" />
          <div className="h-3 w-32 rounded bg-muted/50 animate-pulse" />
          <div className="h-8 w-full rounded bg-muted/40 animate-pulse" />
        </div>
      ))}
    </div>
  );
}
