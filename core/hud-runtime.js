/**
 * Antigravity HUD Runtime Engine (v2.0 - Position A: Native Composer Footer Pill)
 * Mounts directly inside .agy-composer-footer immediately to the left of the right-side toolbar cluster (Turbo).
 * - Automatically tracks the active conversation via [data-testid="conversation-view"][data-cascade-id]
 * - Fetches per-conversation telemetry via Electron IPC (__AGY_HUD_FETCH__) only (no local HTTP ports)
 * - Renders a body-mounted fixed popover on click showing context breakdown & step metrics
 */
(function (root) {
  'use strict';

  if (!root) {
    root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  }
  if (!root || root.__AGY_HUD_INITIALIZED__) return;
  root.__AGY_HUD_INITIALIZED__ = true;

  var doc = root.document || (typeof document !== 'undefined' ? document : null);
  if (!doc) return;

  var currentTelemetry = root.__AGY_HUD_INITIAL_DATA__ || null;
  var TELEMETRY_CACHE_MAX = 32;
  var telemetryCache = Object.create(null);
  var telemetryCacheOrder = [];

  function getTelemetryCache(convId) {
    if (!convId || !Object.prototype.hasOwnProperty.call(telemetryCache, convId)) return null;
    var idx = telemetryCacheOrder.indexOf(convId);
    if (idx !== -1 && idx !== telemetryCacheOrder.length - 1) {
      telemetryCacheOrder.splice(idx, 1);
      telemetryCacheOrder.push(convId);
    }
    return telemetryCache[convId];
  }

  function setTelemetryCache(convId, data) {
    if (!convId || !data) return;
    var idx = telemetryCacheOrder.indexOf(convId);
    if (idx !== -1) {
      telemetryCacheOrder.splice(idx, 1);
    } else {
      while (telemetryCacheOrder.length >= TELEMETRY_CACHE_MAX) {
        var oldest = telemetryCacheOrder.shift();
        if (oldest !== undefined) delete telemetryCache[oldest];
      }
    }
    telemetryCacheOrder.push(convId);
    telemetryCache[convId] = data;
  }

  if (currentTelemetry && currentTelemetry.conversationId) {
    setTelemetryCache(currentTelemetry.conversationId, currentTelemetry);
  }

  var activeCascadeId = null;
  var breakdownOpen = false;
  var topPopoverOpen = false;
  var currentDailyUsage = null;
  var selectedDailyDate = null;
  var selectedDailyScope = 'day';
  var selectedWeekOffset = 0;
  var lastKnownTodayKey = null;
  var fetchingConvId = null;
  var defaultBaseLimit = 256000;
  var homeInitFetched = false;
  var homeFetching = false;
  var THEME_STORAGE_KEY = 'agy_hud_theme_v2';
  var hudTheme = 'dark';
  var pollTimer = null;
  var mutationObserver = null;
  var cleanupFns = [];
  var destroyed = false;

  var topPopPointerDown = false;
  var topPopScrollLockUntil = 0;
  var topPopDeferredTimer = null;
  var topPopLastViewKey = '';
  var savedTopListScrollTop = 0;
  var savedTopPopScrollTop = 0;

  var bottomPopPointerDown = false;
  var bottomPopScrollLockUntil = 0;
  var bottomPopDeferredTimer = null;
  var bottomPopLastConvKey = '';
  var savedBottomListScrollTop = 0;
  var savedBottomPopScrollTop = 0;
  try {
    if (root.localStorage) {
      var savedTheme = root.localStorage.getItem(THEME_STORAGE_KEY);
      if (savedTheme === 'dark' || savedTheme === 'light') {
        hudTheme = savedTheme;
      }
    }
  } catch (_) {}
  if (currentTelemetry && currentTelemetry.backendPatch && currentTelemetry.backendPatch.patched && Number(currentTelemetry.backendPatch.contextLimit) > 256000) {
    defaultBaseLimit = Number(currentTelemetry.backendPatch.contextLimit);
  }

  function syncThemeClasses() {
    var isLight = hudTheme === 'light';
    var ids = ['agy-hud-topbar', 'agy-hud-top-popover', 'agy-hud-popover', 'agy-hud-footer-cluster'];
    for (var i = 0; i < ids.length; i++) {
      var el = doc.getElementById(ids[i]);
      if (el && el.classList) {
        if (isLight) {
          el.classList.add('agy-theme-light');
          el.classList.remove('agy-theme-dark');
        } else {
          el.classList.add('agy-theme-dark');
          el.classList.remove('agy-theme-light');
        }
      }
    }
  }

  function applyHudTheme(theme, persist) {
    hudTheme = theme === 'light' ? 'light' : 'dark';
    if (persist !== false) {
      try {
        if (root.localStorage) {
          root.localStorage.setItem(THEME_STORAGE_KEY, hudTheme);
        }
      } catch (_) {}
    }
    syncThemeClasses();
    try {
      if (typeof root.CustomEvent === 'function') {
        doc.dispatchEvent(new root.CustomEvent('agy-hud-theme-change', { detail: { theme: hudTheme } }));
      }
    } catch (_) {}
    if (topPopoverOpen) renderTopPopoverContent(currentDailyUsage, { userAction: true });
    if (breakdownOpen) renderPopoverContent(currentTelemetry, { userAction: true });
  }

  function setHudTheme(theme) {
    applyHudTheme(theme, true);
  }

  function toggleHudTheme() {
    setHudTheme(hudTheme === 'dark' ? 'light' : 'dark');
  }

  function getLocalDateKey(d) {
    var dt = d instanceof Date ? d : new Date();
    var y = dt.getFullYear();
    var m = String(dt.getMonth() + 1);
    if (m.length < 2) m = '0' + m;
    var day = String(dt.getDate());
    if (day.length < 2) day = '0' + day;
    return y + '-' + m + '-' + day;
  }

  function shiftDateKey(dateKey, deltaDays) {
    var parts = String(dateKey || '').split('-');
    if (parts.length !== 3) return getLocalDateKey();
    var dt = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 12, 0, 0);
    if (isNaN(dt.getTime())) return getLocalDateKey();
    dt.setDate(dt.getDate() + Number(deltaDays || 0));
    return getLocalDateKey(dt);
  }

  function inferModelVisuals(modelName) {
    var raw = String(modelName || 'Unknown Model').trim();
    if (/orchestrator/i.test(raw)) return { shortLabel: 'Orchestrator', color: '#818cf8', family: 'orchestrator' };
    if (/carbon/i.test(raw)) return { shortLabel: 'Carbon', color: '#38bdf8', family: 'gemini-carbon' };
    if (/argon/i.test(raw)) return { shortLabel: 'Argon', color: '#38bdf8', family: 'gemini-argon' };
    if (/opus[\s-]*5/i.test(raw)) return { shortLabel: 'Opus 5.5', color: '#f59e0b', family: 'claude-opus-5' };
    if (/sonnet[\s-]*5/i.test(raw)) return { shortLabel: 'Sonnet 5.5', color: '#fb923c', family: 'claude-sonnet-5' };
    if (/opus[\s-]*4[-.]8/i.test(raw)) return { shortLabel: 'Opus 4.8', color: '#f59e0b', family: 'claude-opus-4-8' };
    if (/opus/i.test(raw)) return { shortLabel: 'Opus 4.6', color: '#f59e0b', family: 'claude-opus' };
    if (/sonnet/i.test(raw)) return { shortLabel: 'Sonnet 4.6', color: '#fb923c', family: 'claude-sonnet' };
    if (/haiku/i.test(raw)) return { shortLabel: 'Haiku', color: '#34d399', family: 'claude-haiku' };
    if (/flash[\s-]*lite/i.test(raw)) return { shortLabel: 'Flash Lite', color: '#2dd4bf', family: 'gemini-flash-lite' };
    if (/flash/i.test(raw)) return { shortLabel: 'Flash', color: '#34d399', family: 'gemini-flash' };
    if (/gemini.*3\.1.*pro.*low/i.test(raw)) return { shortLabel: '3.1 Pro L', color: '#60a5fa', family: 'gemini-pro-low' };
    if (/gemini.*pro/i.test(raw)) return { shortLabel: '3.1 Pro', color: '#60a5fa', family: 'gemini-pro' };
    return { shortLabel: raw.length > 12 ? raw.slice(0, 12) : raw, color: '#38bdf8', family: 'other' };
  }

  function createEmptyDayEntry(dateKey) {
    return {
      date: dateKey,
      totalTokens: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      mainTokens: 0,
      subagentTokens: 0,
      turnCount: 0,
      sessionCount: 0,
      cacheHitRate: 0,
      models: []
    };
  }

  function normalizeDayEntry(dayObj, dateKey) {
    var dKey = (dayObj && dayObj.date) || dateKey || getLocalDateKey();
    if (!dayObj || typeof dayObj !== 'object') return createEmptyDayEntry(dKey);
    var inTok = Number(dayObj.inputTokens || 0);
    var cacheTok = Number(dayObj.cacheReadTokens || 0);
    var outTok = Number(dayObj.outputTokens || 0);
    var totTok = Number(dayObj.totalTokens != null ? dayObj.totalTokens : (inTok + cacheTok + outTok));
    var promptTok = inTok + cacheTok;
    var hitRate = dayObj.cacheHitRate != null
      ? Number(dayObj.cacheHitRate)
      : (promptTok > 0 ? Number(((cacheTok / promptTok) * 100).toFixed(1)) : 0);

    var rawModels = Array.isArray(dayObj.models) ? dayObj.models : [];
    var models = rawModels.map(function (m) {
      var vis = inferModelVisuals(m && m.modelName);
      var mIn = Number((m && m.inputTokens) || 0);
      var mCache = Number((m && m.cacheReadTokens) || 0);
      var mOut = Number((m && m.outputTokens) || 0);
      var mTot = Number(m && m.totalTokens != null ? m.totalTokens : (mIn + mCache + mOut));
      var mPrompt = mIn + mCache;
      var mHit = m && m.cacheHitRate != null
        ? Number(m.cacheHitRate)
        : (mPrompt > 0 ? Number(((mCache / mPrompt) * 100).toFixed(1)) : 0);
      var mShare = m && m.sharePct != null
        ? Number(m.sharePct)
        : (totTok > 0 ? Number(((mTot / totTok) * 100).toFixed(1)) : 0);
      return {
        modelName: String((m && m.modelName) || 'Unknown Model'),
        shortLabel: String((m && m.shortLabel) || vis.shortLabel),
        family: String((m && m.family) || vis.family),
        color: String((m && m.color) || vis.color),
        totalTokens: mTot,
        inputTokens: mIn,
        cacheReadTokens: mCache,
        outputTokens: mOut,
        thinkingTokens: Number((m && m.thinkingTokens) || 0),
        turnCount: Number((m && m.turnCount) || 0),
        sessionCount: Number((m && m.sessionCount) || 0),
        sharePct: mShare,
        cacheHitRate: mHit
      };
    });

    var out = {
      date: dKey,
      totalTokens: totTok,
      inputTokens: inTok,
      cacheReadTokens: cacheTok,
      outputTokens: outTok,
      thinkingTokens: Number(dayObj.thinkingTokens || 0),
      turnCount: Number(dayObj.turnCount || 0),
      sessionCount: Number(dayObj.sessionCount || 0),
      cacheHitRate: hitRate,
      models: models
    };
    if (dayObj.mainTokens != null || dayObj.subagentTokens != null) {
      out.mainTokens = Number(dayObj.mainTokens || 0);
      out.subagentTokens = Number(dayObj.subagentTokens || 0);
    }
    return out;
  }

  function synthesizeFallbackDailyUsage(data) {
    var todayKey = getLocalDateKey();
    if (!data || typeof data !== 'object') {
      return normalizeDailyUsage({ todayKey: todayKey, today: createEmptyDayEntry(todayKey), days: {} });
    }
    var inTok = Number(data.totalInputTokens || 0);
    var cacheTok = Number(data.totalCacheReadTokens || 0);
    var outTok = Number(data.totalOutputTokens || 0);
    var totTok = Number(data.totalTokens != null ? data.totalTokens : (inTok + cacheTok + outTok));
    var turns = Number(data.plannerStepCount || data.stepCount || (totTok > 0 ? 1 : 0));
    var modelName = String(data.modelName || 'Gemini 4 Argon (High)');
    var vis = inferModelVisuals(modelName);
    var promptTok = inTok + cacheTok;
    var hitRate = promptTok > 0 ? Number(((cacheTok / promptTok) * 100).toFixed(1)) : 0;

    var models = totTok > 0 ? [{
      modelName: modelName,
      shortLabel: vis.shortLabel,
      family: vis.family,
      color: vis.color,
      totalTokens: totTok,
      inputTokens: inTok,
      cacheReadTokens: cacheTok,
      outputTokens: outTok,
      thinkingTokens: Number(data.totalThinkingTokens || 0),
      turnCount: turns,
      sessionCount: 1,
      sharePct: 100,
      cacheHitRate: hitRate
    }] : [];

    var todayObj = {
      date: todayKey,
      totalTokens: totTok,
      inputTokens: inTok,
      cacheReadTokens: cacheTok,
      outputTokens: outTok,
      thinkingTokens: Number(data.totalThinkingTokens || 0),
      mainTokens: totTok,
      subagentTokens: 0,
      turnCount: turns,
      sessionCount: totTok > 0 ? 1 : 0,
      cacheHitRate: hitRate,
      models: models
    };
    var daysMap = {};
    daysMap[todayKey] = todayObj;
    return normalizeDailyUsage({
      todayKey: todayKey,
      today: todayObj,
      days: daysMap
    });
  }

  function aggregateDaysBucket(dayEntries, rawBucket, extraMeta) {
    var sumTotal = 0;
    var sumInput = 0;
    var sumCache = 0;
    var sumOutput = 0;
    var sumThinking = 0;
    var sumMain = 0;
    var sumSubagent = 0;
    var sumTurns = 0;
    var sumSessions = 0;
    var activeDays = 0;
    var hasMainSub = false;
    var modelMap = {};
    var modelKeys = [];

    for (var i = 0; i < dayEntries.length; i++) {
      var dObj = dayEntries[i];
      if (!dObj || typeof dObj !== 'object') continue;
      var dTot = Number(dObj.totalTokens || 0);
      if (dTot > 0) activeDays += 1;
      sumTotal += dTot;
      sumInput += Number(dObj.inputTokens || 0);
      sumCache += Number(dObj.cacheReadTokens || 0);
      sumOutput += Number(dObj.outputTokens || 0);
      sumThinking += Number(dObj.thinkingTokens || 0);
      if (dObj.mainTokens != null || dObj.subagentTokens != null) {
        hasMainSub = true;
        sumMain += Number(dObj.mainTokens || 0);
        sumSubagent += Number(dObj.subagentTokens || 0);
      }
      sumTurns += Number(dObj.turnCount || 0);
      sumSessions += Number(dObj.sessionCount || 0);

      var dModels = Array.isArray(dObj.models) ? dObj.models : [];
      for (var j = 0; j < dModels.length; j++) {
        var m = dModels[j];
        if (!m) continue;
        var mName = String(m.modelName || 'Unknown Model');
        var acc = modelMap[mName];
        if (!acc) {
          var vis = inferModelVisuals(mName);
          acc = {
            modelName: mName,
            shortLabel: String(m.shortLabel || vis.shortLabel),
            family: String(m.family || vis.family),
            color: String(m.color || vis.color),
            totalTokens: 0,
            inputTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 0,
            thinkingTokens: 0,
            turnCount: 0,
            sessionCount: 0
          };
          modelMap[mName] = acc;
          modelKeys.push(mName);
        }
        acc.totalTokens += Number(m.totalTokens || 0);
        acc.inputTokens += Number(m.inputTokens || 0);
        acc.cacheReadTokens += Number(m.cacheReadTokens || 0);
        acc.outputTokens += Number(m.outputTokens || 0);
        acc.thinkingTokens += Number(m.thinkingTokens || 0);
        acc.turnCount += Number(m.turnCount || 0);
        acc.sessionCount += Number(m.sessionCount || 0);
      }
    }

    var rawObj = (rawBucket && typeof rawBucket === 'object') ? rawBucket : null;
    var rawTot = rawObj ? Number(rawObj.totalTokens || 0) : 0;
    var useRawPrimary = Boolean(rawObj && rawTot > sumTotal);

    var finalTotal = useRawPrimary ? rawTot : sumTotal;
    var finalInput = useRawPrimary ? Number(rawObj.inputTokens != null ? rawObj.inputTokens : sumInput) : sumInput;
    var finalCache = useRawPrimary ? Number(rawObj.cacheReadTokens != null ? rawObj.cacheReadTokens : sumCache) : sumCache;
    var finalOutput = useRawPrimary ? Number(rawObj.outputTokens != null ? rawObj.outputTokens : sumOutput) : sumOutput;
    var finalThinking = useRawPrimary ? Number(rawObj.thinkingTokens != null ? rawObj.thinkingTokens : sumThinking) : sumThinking;
    var finalTurns = useRawPrimary ? Number(rawObj.turnCount != null ? rawObj.turnCount : sumTurns) : sumTurns;
    var finalSessions = (rawObj && rawTot === sumTotal && Number(rawObj.sessionCount || 0) > 0)
      ? Number(rawObj.sessionCount)
      : (useRawPrimary ? Number(rawObj.sessionCount || sumSessions) : sumSessions);
    var finalDayCount = useRawPrimary
      ? Math.max(activeDays, Number(rawObj.dayCount || (finalTotal > 0 ? 1 : 0)))
      : (activeDays || (rawObj && rawTot === sumTotal ? Number(rawObj.dayCount || 0) : 0));

    var models = [];
    if (useRawPrimary && Array.isArray(rawObj.models) && rawObj.models.length > 0) {
      var normalizedRawBucket = normalizeDayEntry({
        date: 'bucket',
        totalTokens: finalTotal,
        inputTokens: finalInput,
        cacheReadTokens: finalCache,
        outputTokens: finalOutput,
        models: rawObj.models
      }, 'bucket');
      models = normalizedRawBucket.models;
    } else {
      for (var mk = 0; mk < modelKeys.length; mk++) {
        var item = modelMap[modelKeys[mk]];
        var mPrompt = item.inputTokens + item.cacheReadTokens;
        item.sharePct = finalTotal > 0 ? Number(((item.totalTokens / finalTotal) * 100).toFixed(1)) : 0;
        item.cacheHitRate = mPrompt > 0 ? Number(((item.cacheReadTokens / mPrompt) * 100).toFixed(1)) : 0;
        models.push(item);
      }
      models.sort(function (a, b) { return b.totalTokens - a.totalTokens; });
    }

    var promptTok = finalInput + finalCache;
    var hitRate = promptTok > 0
      ? Number(((finalCache / promptTok) * 100).toFixed(1))
      : (rawObj && rawObj.cacheHitRate != null ? Number(rawObj.cacheHitRate) : 0);

    var out = {
      totalTokens: finalTotal,
      inputTokens: finalInput,
      cacheReadTokens: finalCache,
      outputTokens: finalOutput,
      thinkingTokens: finalThinking,
      turnCount: finalTurns,
      sessionCount: finalSessions,
      dayCount: finalDayCount,
      cacheHitRate: hitRate,
      models: models
    };
    if (hasMainSub || (rawObj && (rawObj.mainTokens != null || rawObj.subagentTokens != null))) {
      out.mainTokens = useRawPrimary ? Number(rawObj.mainTokens || sumMain) : sumMain;
      out.subagentTokens = useRawPrimary ? Number(rawObj.subagentTokens || sumSubagent) : sumSubagent;
    }
    if (extraMeta && typeof extraMeta === 'object') {
      var eKeys = Object.keys(extraMeta);
      for (var ek = 0; ek < eKeys.length; ek++) {
        out[eKeys[ek]] = extraMeta[eKeys[ek]];
      }
    }
    return out;
  }

  function normalizeDailyUsage(rawDaily) {
    if (!rawDaily || typeof rawDaily !== 'object') {
      var fallbackKey = getLocalDateKey();
      rawDaily = { todayKey: fallbackKey, today: createEmptyDayEntry(fallbackKey), days: {} };
    }
    var todayKey = String(rawDaily.todayKey || (rawDaily.today && rawDaily.today.date) || getLocalDateKey());
    var days = {};
    if (rawDaily.days && typeof rawDaily.days === 'object') {
      var rawKeys = Object.keys(rawDaily.days);
      for (var i = 0; i < rawKeys.length; i++) {
        var k = rawKeys[i];
        days[k] = normalizeDayEntry(rawDaily.days[k], k);
      }
    }
    if (rawDaily.today && typeof rawDaily.today === 'object') {
      days[todayKey] = normalizeDayEntry(rawDaily.today, todayKey);
    } else if (!days[todayKey]) {
      days[todayKey] = createEmptyDayEntry(todayKey);
    }
    var today = days[todayKey];

    var recentDays = [];
    if (Array.isArray(rawDaily.recentDays) && rawDaily.recentDays.length > 0) {
      for (var r = 0; r < rawDaily.recentDays.length; r++) {
        var item = rawDaily.recentDays[r];
        if (!item || !item.date) continue;
        var dDate = String(item.date);
        if (!days[dDate] && (Number(item.totalTokens || 0) > 0 || (Array.isArray(item.models) && item.models.length > 0))) {
          days[dDate] = normalizeDayEntry(item, dDate);
        }
        var dayRef = days[dDate] || normalizeDayEntry(item, dDate);
        var resolvedTot = Math.max(Number(dayRef.totalTokens || 0), Number(item.totalTokens != null ? item.totalTokens : 0));
        var topColor = (dayRef.models && dayRef.models[0] && dayRef.models[0].color) || item.topModelColor || '#60a5fa';
        recentDays.push({
          date: dDate,
          label: String(item.label || dDate.slice(5)),
          isToday: Boolean(item.isToday != null ? item.isToday : (dDate === todayKey)),
          totalTokens: resolvedTot,
          topModelColor: topColor,
          models: (dayRef.models && dayRef.models.length > 0) ? dayRef.models : (item.models || [])
        });
      }
    } else {
      for (var offset = 6; offset >= 0; offset--) {
        var dKey = shiftDateKey(todayKey, -offset);
        var dEntry = days[dKey] || createEmptyDayEntry(dKey);
        var dColor = (dEntry.models && dEntry.models[0] && dEntry.models[0].color) || '#60a5fa';
        recentDays.push({
          date: dKey,
          label: dKey.slice(5),
          isToday: dKey === todayKey,
          totalTokens: dEntry.totalTokens,
          topModelColor: dColor,
          models: dEntry.models || []
        });
      }
    }

    var dateSet = {};
    if (Array.isArray(rawDaily.availableDates)) {
      for (var a = 0; a < rawDaily.availableDates.length; a++) {
        if (rawDaily.availableDates[a]) dateSet[String(rawDaily.availableDates[a])] = true;
      }
    }
    var dKeys = Object.keys(days);
    for (var dk = 0; dk < dKeys.length; dk++) {
      dateSet[dKeys[dk]] = true;
    }
    dateSet[todayKey] = true;
    var availableDates = Object.keys(dateSet).sort();

    var weeklyDayList = [];
    for (var w = 0; w < recentDays.length; w++) {
      var rDate = recentDays[w].date;
      weeklyDayList.push(days[rDate] || normalizeDayEntry(recentDays[w], rDate));
    }
    var startDate = recentDays.length > 0 ? recentDays[0].date : shiftDateKey(todayKey, -6);
    var endDate = recentDays.length > 0 ? recentDays[recentDays.length - 1].date : todayKey;
    var weekly = aggregateDaysBucket(weeklyDayList, rawDaily.weekly, {
      startDate: String((rawDaily.weekly && rawDaily.weekly.startDate) || startDate),
      endDate: String((rawDaily.weekly && rawDaily.weekly.endDate) || endDate)
    });

    var allDayList = [];
    var allDayKeys = Object.keys(days).sort();
    for (var ak = 0; ak < allDayKeys.length; ak++) {
      allDayList.push(days[allDayKeys[ak]]);
    }
    var grandTotal = aggregateDaysBucket(allDayList, rawDaily.grandTotal, null);

    return {
      todayKey: todayKey,
      today: today,
      weekly: weekly,
      days: days,
      recentDays: recentDays,
      availableDates: availableDates,
      grandTotal: grandTotal
    };
  }

  if (currentTelemetry) {
    if (currentTelemetry.dailyUsage) {
      currentDailyUsage = normalizeDailyUsage(currentTelemetry.dailyUsage);
    } else if (Number(currentTelemetry.totalTokens || 0) > 0 || Number(currentTelemetry.totalInputTokens || 0) > 0) {
      currentDailyUsage = synthesizeFallbackDailyUsage(currentTelemetry);
    }
    if (currentDailyUsage) {
      lastKnownTodayKey = currentDailyUsage.todayKey;
      selectedDailyDate = currentDailyUsage.todayKey;
    }
  }

  function noteBackendPatchFromData(data) {
    if (data && data.backendPatch && data.backendPatch.patched && Number(data.backendPatch.contextLimit) > 256000) {
      defaultBaseLimit = Number(data.backendPatch.contextLimit);
    }
  }

  function getIdleContextLimit() {
    var footer = findComposerFooter();
    if (footer) {
      var btns = footer.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        if (b.id === 'agy-hud-toggle-btn') continue;
        var txt = String(b.textContent || '').trim();
        if (!txt || txt.length > 64) continue;
        if (/claude[\s-]*(?:opus|sonnet)[\s-]*5[-.]5|claude[\s-]*opus[\s-]*4[-.]8/i.test(txt)) return 840000;
        if (/claude[\s-]*(?:opus|sonnet|haiku)[\s-]*4(?:[-.](?:5|6))?/i.test(txt)) return 160000;
        if (/gemini[\s-]*3\.1[\s-]*pro[\s-]*\(?low|gemini[\s-]*3\.5[\s-]*flash[\s-]*lite/i.test(txt)) return 128000;
      }
    }
    return defaultBaseLimit;
  }

  function fetchHomeTelemetry() {
    if (homeFetching || typeof root.__AGY_HUD_FETCH__ !== 'function') return;
    homeFetching = true;
    Promise.resolve(root.__AGY_HUD_FETCH__('__HOME__'))
      .then(function (data) {
        homeFetching = false;
        if (destroyed) return;
        if (data && !data.error) {
          noteBackendPatchFromData(data);
          if (data.dailyUsage) {
            updateDailyUsage(data.dailyUsage, data);
          }
          if (!currentTelemetry || activeCascadeId === '__HOME__') {
            renderFooterPill(currentTelemetry);
          }
        }
      }, function () {
        homeFetching = false;
      });
  }

  function ensureHomeInitFetched() {
    if (homeInitFetched || typeof root.__AGY_HUD_FETCH__ !== 'function') return;
    homeInitFetched = true;
    fetchHomeTelemetry();
  }

  function setText(el, val) {
    if (el && el.textContent !== val) el.textContent = val;
  }

  function setAttr(el, name, val) {
    if (el && el.getAttribute(name) !== val) el.setAttribute(name, val);
  }

  function setDisplay(el, val) {
    if (el && el.style.display !== val) el.style.display = val;
  }

  function setHtmlIfChanged(el, html) {
    if (!el) return false;
    var next = String(html == null ? '' : html);
    if (el.__agyHtml === next && (next === '' ? el.childNodes.length === 0 : el.childNodes.length > 0)) {
      return false;
    }
    el.innerHTML = next;
    el.__agyHtml = next;
    return true;
  }

  function formatK(n) {
    var num = Number(n || 0);
    if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
    return String(num);
  }

  function formatLimitK(n) {
    return formatK(n).replace(/\.0k$/, 'k');
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeColor(c, fallback) {
    var s = String(c || '').trim();
    return /^#[0-9a-f]{3,8}$/i.test(s) ? s : (fallback || '#38bdf8');
  }

  var SVG_CHEVRON_10 = '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5L6 7.5L9 4.5"/></svg>';
  var SVG_BOLT_11 = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>';
  var SVG_BOLT_13 = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>';
  var SVG_CHART_13 = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg>';
  var SVG_FLAME_13 = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>';

  function injectStyles() {
    if (doc.getElementById('agy-hud-styles')) return;
    var uiFont = '"Segoe UI Variable Text", "Segoe UI", "Noto Sans SC", "MiSans", "PingFang SC", "HarmonyOS Sans SC", system-ui, sans-serif';
    var numFont = '"Segoe UI Variable Display", "Segoe UI Variable Text", "Segoe UI", "Noto Sans SC", "MiSans", sans-serif';
    var style = doc.createElement('style');
    style.id = 'agy-hud-styles';
    style.textContent = [
      '.agy-hud-footer-cluster, .agy-hud-popover, .agy-hud-topbar, .agy-hud-top-popover {',
      '  font-family: ' + uiFont + ';',
      '  font-synthesis: none;',
      '  -webkit-font-smoothing: antialiased;',
      '  -moz-osx-font-smoothing: grayscale;',
      '  text-rendering: optimizeLegibility;',
      '}',
      '.agy-hud-topbar button, .agy-hud-top-popover button, .agy-hud-footer-cluster button, .agy-hud-popover button {',
      '  appearance: none;',
      '  -webkit-appearance: none;',
      '  font-family: inherit;',
      '  font-synthesis: none;',
      '  box-sizing: border-box;',
      '  margin: 0;',
      '  text-transform: none;',
      '  letter-spacing: normal;',
      '}',
      '.agy-hud-speed-text svg, .agy-hud-pop-title svg, .agy-pop-icon-val svg, .agy-pop-icon-label svg, .agy-theme-toggle-btn svg, .agy-hud-chevron svg, .agy-hud-top-chevron svg {',
      '  flex-shrink: 0;',
      '  display: block;',
      '}',
      '.agy-top-total, .agy-top-model-val, .agy-top-summary, .agy-kpi-val, .agy-7d-val, .agy-hm-week-val, .agy-hm-cell, .agy-lifecycle-pill, .agy-model-total, .agy-model-pct, .agy-top-date-label, .agy-hud-ctx-text, .agy-hud-speed-text, .agy-hud-pop-card-val, .agy-hud-pop-row-val {',
      '  font-family: ' + numFont + ';',
      '  font-variant-numeric: tabular-nums;',
      '  font-feature-settings: "tnum" 1;',
      '}',
      /* Bottom Composer Footer HUD (Original Clean Transparent Pill) */
      '.agy-hud-footer-cluster {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  flex-shrink: 0;',
      '  margin-right: 2px;',
      '  user-select: none;',
      '}',
      '.agy-hud-pill-btn {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 5px;',
      '  height: 24px;',
      '  padding: 0 7px;',
      '  border-radius: 6px;',
      '  border: 1px solid transparent;',
      '  background: transparent;',
      '  color: rgba(161, 161, 170, 0.92);',
      '  font-family: inherit;',
      '  font-size: 12px;',
      '  line-height: 16px;',
      '  font-variant-numeric: tabular-nums;',
      '  cursor: pointer;',
      '  transition: background-color 0.12s ease, color 0.12s ease, border-color 0.12s ease;',
      '  white-space: nowrap;',
      '}',
      '.agy-hud-pill-btn:hover {',
      '  background: rgba(255, 255, 255, 0.06);',
      '  color: #f4f4f5;',
      '}',
      '.agy-hud-pill-btn[aria-expanded="true"] {',
      '  background: rgba(255, 255, 255, 0.09);',
      '  border-color: rgba(255, 255, 255, 0.1);',
      '  color: #f4f4f5;',
      '}',
      '.agy-hud-ring {',
      '  flex-shrink: 0;',
      '  display: block;',
      '}',
      '.agy-hud-ring-track {',
      '  stroke: rgba(255, 255, 255, 0.14);',
      '}',
      '.agy-hud-ring-arc {',
      '  stroke: #10b981;',
      '  transition: stroke-dashoffset 0.25s ease, stroke 0.25s ease;',
      '}',
      '.agy-hud-ring-arc.warn { stroke: #f59e0b; }',
      '.agy-hud-ring-arc.danger { stroke: #ef4444; }',
      '.agy-hud-ctx-text {',
      '  font-weight: 500;',
      '  color: #d4d4d8;',
      '}',
      '.agy-hud-ctx-text.warn { color: #fbbf24; }',
      '.agy-hud-ctx-text.danger { color: #f87171; }',
      '.agy-hud-sep {',
      '  opacity: 0.38;',
      '  font-size: 11px;',
      '}',
      '.agy-hud-sub-text {',
      '  color: rgba(161, 161, 170, 0.88);',
      '}',
      '.agy-hud-speed-text {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 3px;',
      '  color: rgba(212, 212, 216, 0.92);',
      '}',
      '.agy-pop-icon-val, .agy-pop-icon-label {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 5px;',
      '}',
      '.agy-hud-chevron, .agy-hud-top-chevron {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  opacity: 0.55;',
      '  margin-left: 1px;',
      '  transition: transform 0.16s ease, opacity 0.12s ease;',
      '}',
      '.agy-hud-chevron.is-open, .agy-hud-top-chevron.is-open {',
      '  transform: rotate(180deg);',
      '  opacity: 0.9;',
      '}',
      '.agy-hud-popover {',
      '  position: fixed;',
      '  z-index: 2147483647;',
      '  width: 396px;',
      '  max-width: calc(100vw - 24px);',
      '  max-height: calc(100vh - 44px);',
      '  overflow-y: auto;',
      '  overscroll-behavior: contain;',
      '  background: rgba(15, 17, 23, 0.97);',
      '  backdrop-filter: blur(24px) saturate(180%);',
      '  -webkit-backdrop-filter: blur(24px) saturate(180%);',
      '  border: 1px solid rgba(255, 255, 255, 0.1);',
      '  border-radius: 16px;',
      '  padding: 15px;',
      '  box-shadow: 0 24px 48px -12px rgba(0, 0, 0, 0.75), 0 4px 16px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.08);',
      '  color: #f1f5f9;',
      '  font-size: 12px;',
      '  line-height: 1.45;',
      '  font-variant-numeric: tabular-nums;',
      '  user-select: none;',
      '}',
      '.agy-hud-pop-header {',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  margin-bottom: 10px;',
      '  padding-bottom: 8px;',
      '  border-bottom: 1px solid rgba(255, 255, 255, 0.08);',
      '}',
      '.agy-hud-pop-title {',
      '  font-size: 13px;',
      '  font-weight: 700;',
      '  color: #f8fafc;',
      '  letter-spacing: -0.015em;',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 6px;',
      '}',
      '.agy-hud-pop-badge {',
      '  font-size: 11px;',
      '  font-weight: 600;',
      '  padding: 2px 8px;',
      '  border-radius: 999px;',
      '  background: rgba(255, 255, 255, 0.06);',
      '  border: 1px solid rgba(255, 255, 255, 0.08);',
      '  color: #94a3b8;',
      '}',
      '.agy-hud-pop-grid {',
      '  display: grid;',
      '  grid-template-columns: 1fr 1fr;',
      '  gap: 8px;',
      '  margin-bottom: 12px;',
      '}',
      '.agy-hud-pop-card {',
      '  background: #161922;',
      '  border: 1px solid rgba(255, 255, 255, 0.07);',
      '  border-radius: 11px;',
      '  padding: 8px 10px;',
      '  transition: background-color 0.12s ease, border-color 0.12s ease;',
      '}',
      '.agy-hud-pop-card:hover {',
      '  background: #1c202b;',
      '  border-color: rgba(255, 255, 255, 0.12);',
      '}',
      '.agy-hud-pop-card.agy-hud-pop-wide {',
      '  grid-column: 1 / -1;',
      '  display: flex;',
      '  align-items: baseline;',
      '  justify-content: space-between;',
      '  gap: 8px;',
      '}',
      '.agy-hud-pop-card-label {',
      '  font-size: 11.5px;',
      '  font-weight: 600;',
      '  color: #94a3b8;',
      '  margin-bottom: 3px;',
      '}',
      '.agy-hud-pop-card-val {',
      '  font-size: 14.5px;',
      '  font-weight: 700;',
      '  color: #f8fafc;',
      '  letter-spacing: -0.02em;',
      '}',
      '.agy-hud-pop-card-sub {',
      '  font-size: 11px;',
      '  font-weight: 500;',
      '  color: #64748b;',
      '  margin-top: 2px;',
      '}',
      '.agy-val-muted { font-weight: 500; color: #94a3b8; font-size: 11.5px; }',
      '.agy-val-emerald { color: #34d399; }',
      '.agy-val-amber { color: #fbbf24; }',
      '.agy-val-blue { color: #60a5fa; }',
      '.agy-pop-empty-note { color: #94a3b8; padding: 8px 4px; font-size: 12px; line-height: 1.5; }',
      '.agy-hud-pop-bar {',
      '  height: 6px;',
      '  background: rgba(255, 255, 255, 0.08);',
      '  border-radius: 999px;',
      '  overflow: hidden;',
      '  display: flex;',
      '  margin-bottom: 12px;',
      '}',
      '.agy-hud-pop-bar-cache { background: #10b981; height: 100%; }',
      '.agy-hud-pop-bar-new { background: #f59e0b; height: 100%; }',
      '.agy-hud-pop-section-title {',
      '  font-size: 11.5px;',
      '  font-weight: 600;',
      '  color: #94a3b8;',
      '  margin-bottom: 6px;',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '}',
      '.agy-hud-pop-list {',
      '  display: flex;',
      '  flex-direction: column;',
      '  gap: 4px;',
      '  max-height: 185px;',
      '  overflow-y: auto;',
      '  overscroll-behavior: contain;',
      '  padding-right: 2px;',
      '}',
      '.agy-hud-pop-row {',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  gap: 8px;',
      '  padding: 6px 9px;',
      '  border-radius: 8px;',
      '  background: #161922;',
      '  border: 1px solid rgba(255, 255, 255, 0.06);',
      '  font-size: 11.5px;',
      '  transition: background-color 0.12s ease;',
      '}',
      '.agy-hud-pop-row:hover {',
      '  background: #1c202b;',
      '}',
      '.agy-hud-pop-row-label {',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '  white-space: nowrap;',
      '  color: #e2e8f0;',
      '  font-weight: 500;',
      '}',
      '.agy-hud-pop-row-val {',
      '  flex-shrink: 0;',
      '  font-weight: 700;',
      '  color: #fbbf24;',
      '}',
      '.agy-hud-topbar {',
      '  position: fixed;',
      '  top: 3px;',
      '  left: 50%;',
      '  transform: translateX(-50%);',
      '  z-index: 2147483646;',
      '  height: 24px;',
      '  display: inline-flex;',
      '  align-items: center;',
      '  pointer-events: none;',
      '  user-select: none;',
      '  max-width: calc(100vw - 320px);',
      '}',
      '.agy-hud-topbar-btn {',
      '  pointer-events: auto;',
      '  -webkit-app-region: no-drag;',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 7px;',
      '  height: 24px;',
      '  padding: 0 11px;',
      '  overflow: hidden;',
      '  min-width: 0;',
      '  max-width: 100%;',
      '  border-radius: 999px;',
      '  border: 1px solid rgba(255, 255, 255, 0.09);',
      '  background: rgba(20, 20, 22, 0.92);',
      '  backdrop-filter: blur(16px) saturate(160%);',
      '  -webkit-backdrop-filter: blur(16px) saturate(160%);',
      '  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.06);',
      '  color: #f4f4f5;',
      '  font-family: inherit;',
      '  font-size: 11.5px;',
      '  line-height: 1;',
      '  font-variant-numeric: tabular-nums;',
      '  cursor: pointer;',
      '  white-space: nowrap;',
      '  transition: all 0.14s ease;',
      '}',
      '.agy-hud-topbar-btn:hover {',
      '  background: rgba(30, 30, 34, 0.96);',
      '  border-color: rgba(255, 255, 255, 0.18);',
      '  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.1);',
      '  color: #ffffff;',
      '}',
      '.agy-hud-topbar-btn[aria-expanded="true"] {',
      '  background: rgba(34, 34, 38, 0.98);',
      '  border-color: rgba(255, 255, 255, 0.22);',
      '  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.1);',
      '  color: #ffffff;',
      '}',
      '.agy-top-badge {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 5px;',
      '  font-weight: 500;',
      '  color: #a1a1aa;',
      '  font-size: 11.5px;',
      '  white-space: nowrap;',
      '  flex-shrink: 0;',
      '}',
      '.agy-top-status-dot {',
      '  width: 6px;',
      '  height: 6px;',
      '  border-radius: 50%;',
      '  background: #10b981;',
      '  box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.2);',
      '  flex-shrink: 0;',
      '}',
      '.agy-top-total {',
      '  font-weight: 550;',
      '  color: #fafafa;',
      '  font-size: 11.5px;',
      '  letter-spacing: -0.01em;',
      '  white-space: nowrap;',
      '  flex-shrink: 0;',
      '}',
      '.agy-top-models {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 5px;',
      '  overflow: hidden;',
      '  min-width: 0;',
      '  flex-shrink: 1;',
      '}',
      '.agy-top-model-chip {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 4px;',
      '  font-size: 11px;',
      '  line-height: 1.35;',
      '  padding: 1px 7px;',
      '  border-radius: 999px;',
      '  background: rgba(255, 255, 255, 0.055);',
      '  border: 1px solid rgba(255, 255, 255, 0.06);',
      '  white-space: nowrap;',
      '  flex-shrink: 0;',
      '}',
      '.agy-top-dot {',
      '  width: 6px;',
      '  height: 6px;',
      '  border-radius: 50%;',
      '  display: inline-block;',
      '  flex-shrink: 0;',
      '}',
      '.agy-top-model-name {',
      '  color: #e4e4e7;',
      '  font-weight: 500;',
      '  white-space: nowrap;',
      '}',
      '.agy-top-model-val {',
      '  color: #a1a1aa;',
      '  font-weight: 500;',
      '  white-space: nowrap;',
      '}',
      '.agy-top-more {',
      '  font-size: 11px;',
      '  font-weight: 600;',
      '  color: #a1a1aa;',
      '  padding: 0 2px;',
      '  white-space: nowrap;',
      '}',
      '.agy-top-model-empty {',
      '  font-size: 11.5px;',
      '  font-weight: 500;',
      '  color: #71717a;',
      '  white-space: nowrap;',
      '}',
      '.agy-top-summary {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 4px;',
      '  padding-left: 7px;',
      '  border-left: 1px solid rgba(255, 255, 255, 0.1);',
      '  color: #a1a1aa;',
      '  font-size: 11px;',
      '  font-weight: 500;',
      '  white-space: nowrap;',
      '  flex-shrink: 0;',
      '}',
      '.agy-top-minibar {',
      '  width: 28px;',
      '  height: 4px;',
      '  border-radius: 999px;',
      '  overflow: hidden;',
      '  display: inline-flex;',
      '  gap: 1px;',
      '  background: rgba(255, 255, 255, 0.09);',
      '  flex-shrink: 0;',
      '}',
      '.agy-hud-top-popover {',
      '  position: fixed;',
      '  top: 32px;',
      '  z-index: 2147483647;',
      '  width: 484px;',
      '  max-width: calc(100vw - 24px);',
      '  max-height: calc(100vh - 44px);',
      '  overflow-y: auto;',
      '  overscroll-behavior: contain;',
      '  -webkit-app-region: no-drag;',
      '  background: rgba(18, 18, 21, 0.98);',
      '  backdrop-filter: blur(24px) saturate(160%);',
      '  -webkit-backdrop-filter: blur(24px) saturate(160%);',
      '  border: 1px solid rgba(255, 255, 255, 0.09);',
      '  border-radius: 14px;',
      '  padding: 15px 16px;',
      '  box-shadow: 0 24px 48px -12px rgba(0, 0, 0, 0.85), 0 6px 18px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.06);',
      '  color: #f4f4f5;',
      '  font-size: 12px;',
      '  line-height: 1.45;',
      '  font-variant-numeric: tabular-nums;',
      '  user-select: none;',
      '}',
      '.agy-top-pop-header {',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  flex-wrap: wrap;',
      '  gap: 10px;',
      '  margin-bottom: 12px;',
      '  padding-bottom: 10px;',
      '  border-bottom: 1px solid rgba(255, 255, 255, 0.07);',
      '  white-space: nowrap;',
      '}',
      '.agy-top-header-left {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 8px;',
      '  flex-shrink: 0;',
      '  white-space: nowrap;',
      '}',
      '.agy-top-header-right {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 6px;',
      '  flex-shrink: 0;',
      '  white-space: nowrap;',
      '}',
      '.agy-top-pop-title {',
      '  font-size: 13px;',
      '  font-weight: 500;',
      '  color: #f4f4f5;',
      '  white-space: nowrap;',
      '  flex-shrink: 0;',
      '}',
      '.agy-scope-tabs {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  padding: 2px;',
      '  border-radius: 8px;',
      '  background: #18181c;',
      '  border: 1px solid rgba(255, 255, 255, 0.07);',
      '  gap: 2px;',
      '  flex-shrink: 0;',
      '  white-space: nowrap;',
      '}',
      '.agy-scope-tab {',
      '  height: 23px;',
      '  padding: 0 11px;',
      '  border-radius: 6px;',
      '  border: none;',
      '  background: transparent;',
      '  color: #a1a1aa;',
      '  font-size: 11.5px;',
      '  font-weight: 400;',
      '  font-family: inherit;',
      '  cursor: pointer;',
      '  white-space: nowrap;',
      '  flex-shrink: 0;',
      '  transition: all 0.12s ease;',
      '}',
      '.agy-scope-tab:hover {',
      '  color: #fafafa;',
      '}',
      '.agy-scope-tab.active {',
      '  background: #27272c;',
      '  color: #fafafa;',
      '  font-weight: 500;',
      '  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 1px 3px rgba(0, 0, 0, 0.35);',
      '}',
      '.agy-page-bar {',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  flex-wrap: wrap;',
      '  gap: 8px;',
      '  margin-bottom: 10px;',
      '  min-height: 24px;',
      '  white-space: nowrap;',
      '}',
      '.agy-page-bar-title {',
      '  font-size: 12px;',
      '  font-weight: 500;',
      '  color: #e4e4e7;',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 4px;',
      '  white-space: nowrap;',
      '}',
      '.agy-lifecycle-pill {',
      '  font-size: 11px;',
      '  font-weight: 500;',
      '  color: #a1a1aa;',
      '  background: #18181c;',
      '  border: 1px solid rgba(255, 255, 255, 0.08);',
      '  padding: 2px 8px;',
      '  border-radius: 6px;',
      '  white-space: nowrap;',
      '}',
      '.agy-top-nav-cluster {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 4px;',
      '  flex-shrink: 0;',
      '  white-space: nowrap;',
      '}',
      '.agy-top-nav-btn {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  width: 22px;',
      '  height: 22px;',
      '  border-radius: 6px;',
      '  border: 1px solid rgba(255, 255, 255, 0.08);',
      '  background: #1a1a1e;',
      '  color: #d4d4d8;',
      '  font-size: 13px;',
      '  font-weight: 600;',
      '  line-height: 1;',
      '  cursor: pointer;',
      '  padding: 0;',
      '  flex-shrink: 0;',
      '  transition: all 0.12s ease;',
      '}',
      '.agy-top-nav-btn.agy-nav-wide {',
      '  width: auto;',
      '  padding: 0 7px;',
      '  font-size: 11px;',
      '  font-weight: 500;',
      '}',
      '.agy-top-nav-btn:hover:not(:disabled) {',
      '  background: #27272c;',
      '  border-color: rgba(255, 255, 255, 0.16);',
      '  color: #ffffff;',
      '}',
      '.agy-top-nav-btn:disabled {',
      '  opacity: 0.28;',
      '  cursor: default;',
      '}',
      '.agy-top-date-label {',
      '  font-size: 11.5px;',
      '  font-weight: 500;',
      '  color: #e4e4e7;',
      '  padding: 0 5px;',
      '  text-align: center;',
      '  white-space: nowrap;',
      '  flex-shrink: 0;',
      '}',
      '.agy-top-nav-today {',
      '  height: 22px;',
      '  padding: 0 8px;',
      '  border-radius: 6px;',
      '  border: 1px solid rgba(255, 255, 255, 0.1);',
      '  background: #1a1a1e;',
      '  color: #e4e4e7;',
      '  font-size: 11px;',
      '  font-weight: 600;',
      '  font-family: inherit;',
      '  cursor: pointer;',
      '  white-space: nowrap;',
      '  flex-shrink: 0;',
      '  transition: all 0.12s ease;',
      '}',
      '.agy-top-nav-today:hover {',
      '  background: #27272c;',
      '  border-color: rgba(255, 255, 255, 0.2);',
      '  color: #ffffff;',
      '}',
      '.agy-theme-toggle-btn {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  gap: 4px;',
      '  height: 25px;',
      '  padding: 0 8px;',
      '  border-radius: 7px;',
      '  border: 1px solid rgba(255, 255, 255, 0.08);',
      '  background: #18181c;',
      '  color: #a1a1aa;',
      '  font-size: 11px;',
      '  font-weight: 600;',
      '  font-family: inherit;',
      '  cursor: pointer;',
      '  white-space: nowrap;',
      '  flex-shrink: 0;',
      '  transition: all 0.12s ease;',
      '}',
      '.agy-theme-toggle-btn:hover {',
      '  background: #27272c;',
      '  border-color: rgba(255, 255, 255, 0.16);',
      '  color: #fafafa;',
      '}',
      '.agy-kpi-strip {',
      '  display: grid;',
      '  grid-template-columns: repeat(3, minmax(0, 1fr));',
      '  gap: 8px;',
      '  margin-bottom: 13px;',
      '}',
      '.agy-kpi-grid-4 {',
      '  display: grid;',
      '  grid-template-columns: repeat(2, minmax(0, 1fr));',
      '  gap: 7px;',
      '  margin-bottom: 12px;',
      '}',
      '.agy-kpi-card {',
      '  display: flex;',
      '  flex-direction: column;',
      '  align-items: flex-start;',
      '  padding: 9px 11px;',
      '  border: 1px solid rgba(255, 255, 255, 0.07);',
      '  border-radius: 10px;',
      '  background: #18181c;',
      '  color: inherit;',
      '  text-align: left;',
      '  cursor: default;',
      '  min-width: 0;',
      '}',
      '.agy-kpi-lbl {',
      '  font-size: 11px;',
      '  color: #a1a1aa;',
      '  margin-bottom: 3px;',
      '  font-weight: 450;',
      '  white-space: nowrap;',
      '}',
      '.agy-kpi-val {',
      '  font-size: 16px;',
      '  font-weight: 550;',
      '  color: #fafafa;',
      '  letter-spacing: -0.02em;',
      '  line-height: 1.2;',
      '  white-space: nowrap;',
      '}',
      '.agy-kpi-sub {',
      '  font-size: 10.5px;',
      '  font-weight: 450;',
      '  color: #71717a;',
      '  margin-top: 3px;',
      '  white-space: nowrap;',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '  max-width: 100%;',
      '}',
      '.agy-sec-sub {',
      '  font-weight: 500;',
      '  color: #71717a;',
      '  margin-left: 4px;',
      '  font-size: 11px;',
      '}',
      '.agy-sec-hint {',
      '  font-size: 10.5px;',
      '  font-weight: 450;',
      '  color: #71717a;',
      '}',
      '.agy-hud-total-heatmap {',
      '  display: flex;',
      '  flex-direction: column;',
      '  gap: 5px;',
      '  margin-bottom: 12px;',
      '  padding: 9px 10px;',
      '  border-radius: 10px;',
      '  background: #18181c;',
      '  border: 1px solid rgba(255, 255, 255, 0.07);',
      '}',
      '.agy-hm-row {',
      '  display: grid;',
      '  grid-template-columns: 118px 1fr 56px;',
      '  align-items: center;',
      '  gap: 8px;',
      '}',
      '.agy-hm-week-btn {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  gap: 4px;',
      '  height: 23px;',
      '  padding: 0 7px;',
      '  border-radius: 6px;',
      '  border: 1px solid rgba(255, 255, 255, 0.06);',
      '  background: #1f1f24;',
      '  color: #d4d4d8;',
      '  font-size: 10.5px;',
      '  font-family: inherit;',
      '  cursor: pointer;',
      '  transition: all 0.12s ease;',
      '  white-space: nowrap;',
      '}',
      '.agy-hm-week-btn:hover {',
      '  background: #27272c;',
      '  border-color: rgba(56, 189, 248, 0.4);',
      '  color: #ffffff;',
      '}',
      '.agy-hm-week-tag {',
      '  font-weight: 500;',
      '  color: #a1a1aa;',
      '}',
      '.agy-hm-week-btn:hover .agy-hm-week-tag {',
      '  color: #38bdf8;',
      '}',
      '.agy-hm-week-range {',
      '  font-size: 10px;',
      '  color: #71717a;',
      '}',
      '.agy-hm-cells {',
      '  display: grid;',
      '  grid-template-columns: repeat(7, minmax(0, 1fr));',
      '  gap: 4px;',
      '}',
      '.agy-hm-cell {',
      '  height: 23px;',
      '  border-radius: 5px;',
      '  border: 1px solid rgba(255, 255, 255, 0.05);',
      '  background: rgba(255, 255, 255, 0.03);',
      '  color: #71717a;',
      '  font-size: 10px;',
      '  font-weight: 500;',
      '  display: inline-flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  cursor: pointer;',
      '  padding: 0;',
      '  transition: border-color 0.12s ease, background-color 0.12s ease, color 0.12s ease;',
      '}',
      '.agy-hm-cell:hover {',
      '  border-color: rgba(255, 255, 255, 0.42);',
      '  color: #ffffff;',
      '}',
      '.agy-hm-cell.level-0 {',
      '  background: rgba(255, 255, 255, 0.03);',
      '  color: #52525b;',
      '}',
      '.agy-hm-cell.level-1 {',
      '  background: rgba(56, 189, 248, 0.16);',
      '  border-color: rgba(56, 189, 248, 0.24);',
      '  color: #bae6fd;',
      '}',
      '.agy-hm-cell.level-2 {',
      '  background: rgba(56, 189, 248, 0.30);',
      '  border-color: rgba(56, 189, 248, 0.38);',
      '  color: #e0f2fe;',
      '}',
      '.agy-hm-cell.level-3 {',
      '  background: rgba(56, 189, 248, 0.48);',
      '  border-color: rgba(56, 189, 248, 0.56);',
      '  color: #f0f9ff;',
      '}',
      '.agy-hm-cell.level-4 {',
      '  background: rgba(56, 189, 248, 0.68);',
      '  border-color: rgba(56, 189, 248, 0.82);',
      '  color: #ffffff;',
      '  font-weight: 600;',
      '}',
      '.agy-hm-cell.is-today {',
      '  box-shadow: inset 0 0 0 1px rgba(245, 158, 11, 0.7);',
      '}',
      '.agy-hm-week-val {',
      '  text-align: right;',
      '  font-size: 11px;',
      '  font-weight: 550;',
      '  color: #e4e4e7;',
      '  white-space: nowrap;',
      '}',
      '.agy-hud-7d-chart {',
      '  display: grid;',
      '  grid-template-columns: repeat(7, minmax(0, 1fr));',
      '  gap: 5px;',
      '  height: auto;',
      '  margin-bottom: 12px;',
      '  padding: 10px 8px 8px;',
      '  border-radius: 10px;',
      '  background: #18181c;',
      '  border: 1px solid rgba(255, 255, 255, 0.07);',
      '}',
      '.agy-7d-col {',
      '  display: flex;',
      '  flex-direction: column;',
      '  align-items: center;',
      '  justify-content: flex-end;',
      '  gap: 6px;',
      '  padding: 6px 2px;',
      '  border-radius: 8px;',
      '  border: 1px solid transparent;',
      '  background: transparent;',
      '  color: inherit;',
      '  cursor: pointer;',
      '  font-family: inherit;',
      '  transition: all 0.12s ease;',
      '}',
      '.agy-7d-col:hover {',
      '  background: rgba(255, 255, 255, 0.04);',
      '}',
      '.agy-7d-col.active {',
      '  background: #232329;',
      '  border-color: rgba(255, 255, 255, 0.16);',
      '  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);',
      '}',
      '.agy-7d-val {',
      '  font-size: 10.5px;',
      '  font-weight: 450;',
      '  color: #a1a1aa;',
      '  line-height: 1.1;',
      '  white-space: nowrap;',
      '}',
      '.agy-7d-col.active .agy-7d-val {',
      '  color: #fafafa;',
      '  font-weight: 550;',
      '}',
      '.agy-7d-track {',
      '  width: 22px;',
      '  height: 32px;',
      '  flex-shrink: 0;',
      '  border-radius: 4px;',
      '  background: rgba(255, 255, 255, 0.06);',
      '  display: flex;',
      '  align-items: flex-end;',
      '  overflow: hidden;',
      '}',
      '.agy-7d-fill {',
      '  width: 100%;',
      '  border-radius: 4px;',
      '  transition: height 0.2s ease;',
      '}',
      '.agy-7d-lbl {',
      '  font-size: 10.5px;',
      '  font-weight: 450;',
      '  color: #71717a;',
      '  line-height: 1.1;',
      '  white-space: nowrap;',
      '}',
      '.agy-7d-col.active .agy-7d-lbl {',
      '  color: #38bdf8;',
      '  font-weight: 550;',
      '}',
      '.agy-top-stack-bar {',
      '  height: 3px;',
      '  border-radius: 999px;',
      '  background: rgba(255, 255, 255, 0.06);',
      '  overflow: hidden;',
      '  display: flex;',
      '  gap: 2px;',
      '  margin-bottom: 12px;',
      '}',
      '.agy-top-stack-seg {',
      '  height: 100%;',
      '  transition: width 0.2s ease;',
      '}',
      '.agy-hud-model-list {',
      '  display: flex;',
      '  flex-direction: column;',
      '  gap: 6px;',
      '  max-height: 230px;',
      '  overflow-y: auto;',
      '  overscroll-behavior: contain;',
      '  padding-right: 3px;',
      '  border-top: none;',
      '}',
      '.agy-hud-model-list::-webkit-scrollbar,',
      '.agy-hud-pop-list::-webkit-scrollbar,',
      '.agy-hud-top-popover::-webkit-scrollbar,',
      '.agy-hud-popover::-webkit-scrollbar {',
      '  width: 6px;',
      '  height: 6px;',
      '}',
      '.agy-hud-model-list::-webkit-scrollbar-track,',
      '.agy-hud-pop-list::-webkit-scrollbar-track,',
      '.agy-hud-top-popover::-webkit-scrollbar-track,',
      '.agy-hud-popover::-webkit-scrollbar-track {',
      '  background: transparent;',
      '}',
      '.agy-hud-model-list::-webkit-scrollbar-thumb,',
      '.agy-hud-pop-list::-webkit-scrollbar-thumb,',
      '.agy-hud-top-popover::-webkit-scrollbar-thumb,',
      '.agy-hud-popover::-webkit-scrollbar-thumb {',
      '  background: rgba(255, 255, 255, 0.18);',
      '  border-radius: 999px;',
      '}',
      '.agy-hud-model-list::-webkit-scrollbar-thumb:hover,',
      '.agy-hud-pop-list::-webkit-scrollbar-thumb:hover,',
      '.agy-hud-top-popover::-webkit-scrollbar-thumb:hover,',
      '.agy-hud-popover::-webkit-scrollbar-thumb:hover {',
      '  background: rgba(255, 255, 255, 0.30);',
      '}',
      '.agy-hud-top-popover.agy-theme-light .agy-hud-model-list::-webkit-scrollbar-thumb,',
      '.agy-hud-popover.agy-theme-light .agy-hud-pop-list::-webkit-scrollbar-thumb,',
      '.agy-hud-top-popover.agy-theme-light::-webkit-scrollbar-thumb,',
      '.agy-hud-popover.agy-theme-light::-webkit-scrollbar-thumb {',
      '  background: rgba(15, 23, 42, 0.18);',
      '}',
      '.agy-hud-top-popover.agy-theme-light .agy-hud-model-list::-webkit-scrollbar-thumb:hover,',
      '.agy-hud-popover.agy-theme-light .agy-hud-pop-list::-webkit-scrollbar-thumb:hover,',
      '.agy-hud-top-popover.agy-theme-light::-webkit-scrollbar-thumb:hover,',
      '.agy-hud-popover.agy-theme-light::-webkit-scrollbar-thumb:hover {',
      '  background: rgba(15, 23, 42, 0.32);',
      '}',
      '.agy-top-model-row {',
      '  padding: 9px 11px;',
      '  border-radius: 10px;',
      '  background: #18181c;',
      '  border: 1px solid rgba(255, 255, 255, 0.07);',
      '  transition: background-color 0.12s ease, border-color 0.12s ease;',
      '}',
      '.agy-top-model-row:hover {',
      '  background: #1f1f24;',
      '  border-color: rgba(255, 255, 255, 0.13);',
      '}',
      '.agy-top-model-head {',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  gap: 8px;',
      '  margin-bottom: 4px;',
      '  font-size: 12px;',
      '}',
      '.agy-top-model-left {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 6px;',
      '  min-width: 0;',
      '  overflow: hidden;',
      '}',
      '.agy-top-model-left strong {',
      '  font-size: 12px;',
      '  color: #f4f4f5;',
      '  font-weight: 500;',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '  white-space: nowrap;',
      '}',
      '.agy-model-turns {',
      '  font-size: 11px;',
      '  font-weight: 500;',
      '  color: #a1a1aa;',
      '  background: rgba(255, 255, 255, 0.06);',
      '  padding: 1px 6px;',
      '  border-radius: 999px;',
      '  flex-shrink: 0;',
      '}',
      '.agy-top-model-right {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 8px;',
      '  flex-shrink: 0;',
      '}',
      '.agy-model-pct {',
      '  font-size: 11.5px;',
      '  font-weight: 450;',
      '  color: #a1a1aa;',
      '}',
      '.agy-model-total {',
      '  font-size: 12.5px;',
      '  font-weight: 550;',
      '  color: #fafafa;',
      '}',
      '.agy-top-model-bar {',
      '  height: 4px;',
      '  border-radius: 999px;',
      '  background: rgba(255, 255, 255, 0.07);',
      '  overflow: hidden;',
      '  display: flex;',
      '  margin: 5px 0;',
      '}',
      '.agy-top-model-meta {',
      '  font-size: 11.5px;',
      '  font-weight: 500;',
      '  color: #94a3b8;',
      '}',
      '.agy-top-empty-state {',
      '  color: #94a3b8;',
      '  text-align: center;',
      '  padding: 18px 8px;',
      '  font-size: 12px;',
      '  background: #161922;',
      '  border-radius: 10px;',
      '  border: 1px dashed rgba(255, 255, 255, 0.12);',
      '}',
      /* Optional Light Theme Overrides (.agy-theme-light) */
      '.agy-hud-footer-cluster.agy-theme-light .agy-hud-pill-btn {',
      '  background: rgba(255, 255, 255, 0.88);',
      '  border-color: rgba(15, 23, 42, 0.1);',
      '  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);',
      '  color: #334155;',
      '}',
      '.agy-hud-footer-cluster.agy-theme-light .agy-hud-pill-btn:hover,',
      '.agy-hud-footer-cluster.agy-theme-light .agy-hud-pill-btn[aria-expanded="true"] {',
      '  background: #ffffff;',
      '  border-color: rgba(79, 70, 229, 0.3);',
      '  color: #0f172a;',
      '}',
      '.agy-hud-footer-cluster.agy-theme-light .agy-hud-ring-track { stroke: rgba(15, 23, 42, 0.14); }',
      '.agy-hud-footer-cluster.agy-theme-light .agy-hud-ctx-text { color: #0f172a; }',
      '.agy-hud-footer-cluster.agy-theme-light .agy-hud-ctx-text.warn { color: #d97706; }',
      '.agy-hud-footer-cluster.agy-theme-light .agy-hud-ctx-text.danger { color: #dc2626; }',
      '.agy-hud-footer-cluster.agy-theme-light .agy-hud-sub-text { color: #64748b; }',
      '.agy-hud-footer-cluster.agy-theme-light .agy-hud-speed-text { color: #059669; }',
      '.agy-hud-topbar.agy-theme-light .agy-hud-topbar-btn {',
      '  background: rgba(255, 255, 255, 0.94);',
      '  border-color: rgba(15, 23, 42, 0.09);',
      '  box-shadow: 0 2px 8px -1px rgba(15, 23, 42, 0.07), 0 1px 2px rgba(15, 23, 42, 0.04);',
      '  color: #0f172a;',
      '}',
      '.agy-hud-topbar.agy-theme-light .agy-hud-topbar-btn:hover,',
      '.agy-hud-topbar.agy-theme-light .agy-hud-topbar-btn[aria-expanded="true"] {',
      '  background: #ffffff;',
      '  border-color: rgba(79, 70, 229, 0.3);',
      '  color: #0f172a;',
      '}',
      '.agy-hud-topbar.agy-theme-light .agy-top-badge { color: #475569; }',
      '.agy-hud-topbar.agy-theme-light .agy-top-total { color: #0f172a; }',
      '.agy-hud-topbar.agy-theme-light .agy-top-model-chip { background: #f1f5f9; border-color: rgba(15, 23, 42, 0.05); }',
      '.agy-hud-topbar.agy-theme-light .agy-top-model-name { color: #1e293b; }',
      '.agy-hud-topbar.agy-theme-light .agy-top-model-val { color: #64748b; }',
      '.agy-theme-light .agy-top-more,',
      '.agy-theme-light .agy-top-model-empty,',
      '.agy-theme-light .agy-hm-week-tag,',
      '.agy-theme-light .agy-val-muted {',
      '  color: #64748b;',
      '}',
      '.agy-theme-light .agy-hm-week-btn:hover .agy-hm-week-tag {',
      '  color: #0284c7;',
      '}',
      '.agy-theme-light .agy-7d-val,',
      '.agy-theme-light .agy-pop-empty-note {',
      '  color: #475569;',
      '}',
      '.agy-theme-light .agy-top-empty-state {',
      '  background: #f8fafc;',
      '  border-color: #cbd5e1;',
      '  color: #64748b;',
      '}',
      '.agy-hud-topbar.agy-theme-light .agy-top-summary { border-left-color: rgba(15, 23, 42, 0.1); color: #475569; }',
      '.agy-hud-topbar.agy-theme-light .agy-top-minibar { background: #e2e8f0; }',
      '.agy-hud-top-popover.agy-theme-light, .agy-hud-popover.agy-theme-light {',
      '  background: rgba(255, 255, 255, 0.97);',
      '  border-color: rgba(15, 23, 42, 0.08);',
      '  box-shadow: 0 24px 48px -12px rgba(15, 23, 42, 0.16), 0 6px 16px -4px rgba(15, 23, 42, 0.07);',
      '  color: #0f172a;',
      '}',
      '.agy-hud-top-popover.agy-theme-light .agy-top-pop-header, .agy-hud-popover.agy-theme-light .agy-hud-pop-header {',
      '  border-bottom-color: #f1f5f9;',
      '}',
      '.agy-hud-top-popover.agy-theme-light .agy-top-pop-title,',
      '.agy-hud-top-popover.agy-theme-light .agy-page-bar-title,',
      '.agy-hud-top-popover.agy-theme-light .agy-kpi-val,',
      '.agy-hud-top-popover.agy-theme-light .agy-hm-week-val,',
      '.agy-hud-top-popover.agy-theme-light .agy-top-date-label,',
      '.agy-hud-top-popover.agy-theme-light .agy-top-model-left strong,',
      '.agy-hud-top-popover.agy-theme-light .agy-model-total,',
      '.agy-hud-popover.agy-theme-light .agy-hud-pop-title,',
      '.agy-hud-popover.agy-theme-light .agy-hud-pop-card-val {',
      '  color: #0f172a;',
      '}',
      '.agy-hud-top-popover.agy-theme-light .agy-scope-tabs {',
      '  background: #f1f5f9;',
      '  border-color: rgba(15, 23, 42, 0.05);',
      '}',
      '.agy-hud-top-popover.agy-theme-light .agy-scope-tab { color: #64748b; }',
      '.agy-hud-top-popover.agy-theme-light .agy-scope-tab.active {',
      '  background: #ffffff;',
      '  color: #0f172a;',
      '  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.1);',
      '}',
      '.agy-hud-top-popover.agy-theme-light .agy-top-nav-btn,',
      '.agy-hud-top-popover.agy-theme-light .agy-top-nav-today,',
      '.agy-hud-top-popover.agy-theme-light .agy-theme-toggle-btn,',
      '.agy-hud-top-popover.agy-theme-light .agy-lifecycle-pill,',
      '.agy-hud-top-popover.agy-theme-light .agy-hm-week-btn {',
      '  background: #f8fafc;',
      '  border-color: #e2e8f0;',
      '  color: #334155;',
      '}',
      '.agy-hud-top-popover.agy-theme-light .agy-top-nav-btn:hover:not(:disabled),',
      '.agy-hud-top-popover.agy-theme-light .agy-top-nav-today:hover,',
      '.agy-hud-top-popover.agy-theme-light .agy-theme-toggle-btn:hover,',
      '.agy-hud-top-popover.agy-theme-light .agy-hm-week-btn:hover {',
      '  background: #f1f5f9;',
      '  color: #0f172a;',
      '}',
      '.agy-hud-top-popover.agy-theme-light .agy-kpi-card,',
      '.agy-hud-top-popover.agy-theme-light .agy-hud-7d-chart,',
      '.agy-hud-top-popover.agy-theme-light .agy-hud-total-heatmap,',
      '.agy-hud-top-popover.agy-theme-light .agy-top-model-row,',
      '.agy-hud-popover.agy-theme-light .agy-hud-pop-card,',
      '.agy-hud-popover.agy-theme-light .agy-hud-pop-row {',
      '  background: #f8fafc;',
      '  border-color: #e2e8f0;',
      '}',
      '.agy-hud-popover.agy-theme-light .agy-hud-pop-card:hover,',
      '.agy-hud-popover.agy-theme-light .agy-hud-pop-row:hover,',
      '.agy-hud-top-popover.agy-theme-light .agy-top-model-row:hover {',
      '  background: #f1f5f9;',
      '  border-color: #cbd5e1;',
      '}',
      '.agy-hud-top-popover.agy-theme-light .agy-7d-col:hover {',
      '  background: #f1f5f9;',
      '}',
      '.agy-hud-top-popover.agy-theme-light .agy-hm-cell.level-0 {',
      '  background: #f1f5f9;',
      '  border-color: #e2e8f0;',
      '  color: #94a3b8;',
      '}',
      '.agy-hud-top-popover.agy-theme-light .agy-hm-cell.level-1,',
      '.agy-hud-top-popover.agy-theme-light .agy-hm-cell.level-2 {',
      '  color: #0369a1;',
      '}',
      '.agy-hud-top-popover.agy-theme-light .agy-hm-cell.level-3,',
      '.agy-hud-top-popover.agy-theme-light .agy-hm-cell.level-4 {',
      '  color: #0c4a6e;',
      '}',
      '.agy-hud-top-popover.agy-theme-light .agy-7d-col.active .agy-7d-lbl {',
      '  color: #4f46e5;',
      '}',
      '.agy-hud-top-popover.agy-theme-light .agy-7d-col.active {',
      '  background: #ffffff;',
      '  border-color: #cbd5e1;',
      '}',
      '.agy-hud-top-popover.agy-theme-light .agy-7d-col.active .agy-7d-val { color: #0f172a; }',
      '.agy-hud-top-popover.agy-theme-light .agy-7d-track,',
      '.agy-hud-top-popover.agy-theme-light .agy-top-stack-bar,',
      '.agy-hud-top-popover.agy-theme-light .agy-top-model-bar,',
      '.agy-hud-top-popover.agy-theme-light .agy-model-turns,',
      '.agy-hud-popover.agy-theme-light .agy-hud-pop-bar,',
      '.agy-hud-popover.agy-theme-light .agy-hud-pop-badge {',
      '  background: #e2e8f0;',
      '  color: #475569;',
      '}',
      '.agy-hud-top-popover.agy-theme-light .agy-top-model-meta,',
      '.agy-hud-top-popover.agy-theme-light .agy-kpi-lbl,',
      '.agy-hud-top-popover.agy-theme-light .agy-kpi-sub,',
      '.agy-hud-popover.agy-theme-light .agy-hud-pop-card-label,',
      '.agy-hud-popover.agy-theme-light .agy-hud-pop-card-sub,',
      '.agy-hud-popover.agy-theme-light .agy-hud-pop-section-title {',
      '  color: #64748b;',
      '}',
      '.agy-hud-popover.agy-theme-light .agy-hud-pop-row-label { color: #1e293b; }',
      '.agy-hud-popover.agy-theme-light .agy-hud-pop-row-val { color: #d97706; }',
      '.agy-hud-popover.agy-theme-light .agy-val-emerald { color: #059669; }',
      '.agy-hud-popover.agy-theme-light .agy-val-amber { color: #d97706; }',
      '.agy-hud-popover.agy-theme-light .agy-val-blue { color: #2563eb; }',
      '.agy-hud-pill-btn:focus-visible,',
      '.agy-hud-topbar-btn:focus-visible,',
      '.agy-scope-tab:focus-visible,',
      '.agy-top-nav-btn:focus-visible,',
      '.agy-top-nav-today:focus-visible,',
      '.agy-theme-toggle-btn:focus-visible,',
      '.agy-hm-week-btn:focus-visible,',
      '.agy-7d-col:focus-visible,',
      '.agy-hm-cell:focus-visible {',
      '  outline: 2px solid #38bdf8;',
      '  outline-offset: 2px;',
      '}',
      '.agy-theme-light .agy-hud-pill-btn:focus-visible,',
      '.agy-theme-light .agy-hud-topbar-btn:focus-visible,',
      '.agy-theme-light .agy-scope-tab:focus-visible,',
      '.agy-theme-light .agy-top-nav-btn:focus-visible,',
      '.agy-theme-light .agy-top-nav-today:focus-visible,',
      '.agy-theme-light .agy-theme-toggle-btn:focus-visible,',
      '.agy-theme-light .agy-hm-week-btn:focus-visible,',
      '.agy-theme-light .agy-7d-col:focus-visible,',
      '.agy-theme-light .agy-hm-cell:focus-visible {',
      '  outline-color: #0284c7;',
      '}'
    ].join('\n');
    (doc.head || doc.documentElement).appendChild(style);
  }

  function isSubagentComposerFooter(footer) {
    if (!footer || typeof footer.closest !== 'function') return false;
    if (footer.closest('[data-side-panel-composer], [data-testid="side-question-tab-composer"], [data-aux-pane-open="true"], [data-side-panel-open="true"], [data-side-panel-focus-scope="true"]')) {
      return true;
    }
    var box = footer.closest('[data-testid="agent-input-box"], .surface-composer, .surface-composer-card') || footer.parentElement;
    if (box && typeof box.querySelectorAll === 'function') {
      if (box.querySelector && box.querySelector('[title="Subagent"], [title="子代理"], [title="子智能体"]')) return true;
      var inputs = box.querySelectorAll('[aria-placeholder], [placeholder], [data-placeholder], [role="textbox"][aria-label], [contenteditable][aria-label], textarea[aria-label]');
      for (var i = 0; i < inputs.length; i++) {
        var ph = (inputs[i].getAttribute('aria-placeholder') || '') + ' ' +
                 (inputs[i].getAttribute('placeholder') || '') + ' ' +
                 (inputs[i].getAttribute('data-placeholder') || '') + ' ' +
                 (inputs[i].getAttribute('aria-label') || '');
        if (/subagent|子代理|子智能体/i.test(ph)) return true;
      }
      var nodes = box.querySelectorAll('div, span, p');
      var limit = Math.min(nodes.length, 80);
      for (var n = 0; n < limit; n++) {
        var item = nodes[n];
        if (item.children && item.children.length > 0) continue;
        if (item.closest && item.closest('[contenteditable="true"], textarea, input, [role="textbox"], #agy-hud-footer-cluster, #agy-new-chat-persona')) continue;
        if (/message\s+subagent|子代理|子智能体/i.test(item.textContent || '')) return true;
      }
    }
    var btns = footer.querySelectorAll('button, span');
    for (var j = 0; j < btns.length; j++) {
      var t = String(btns[j].textContent || '').trim();
      if (t === 'self') return true;
    }
    return false;
  }

  /**
   * Locate the internal footer toolbar (.agy-composer-footer) inside the bottom input box.
   */
  function findComposerFooter() {
    var convFooters = doc.querySelectorAll('[data-testid="conversation-view"] .agy-composer-footer');
    for (var i = 0; i < convFooters.length; i++) {
      if (!isSubagentComposerFooter(convFooters[i])) return convFooters[i];
    }
    var allFooters = doc.querySelectorAll('.agy-composer-footer, .composer-footer');
    for (var j = 0; j < allFooters.length; j++) {
      if (!isSubagentComposerFooter(allFooters[j])) return allFooters[j];
    }
    return null;
  }

  /**
   * Determine the currently open conversation's UUID from [data-testid="conversation-view"][data-cascade-id].
   * Returns '__HOME__' when on the New Conversation home screen, or null if not tagged.
   */
  function detectActiveCascadeId() {
    var footer = findComposerFooter();
    if (footer && typeof footer.closest === 'function') {
      var owner = footer.closest('[data-cascade-id]');
      if (owner) {
        var cid = owner.getAttribute('data-cascade-id');
        if (cid && /^[0-9a-f-]{36}$/i.test(cid)) return cid;
        if (cid === 'conversation') return '__HOME__';
      }
      if (footer.classList && footer.classList.contains('agy-composer-footer')) {
        var cView = doc.querySelector('[data-testid="conversation-view"][data-cascade-id]');
        if (cView) {
          var cvid = cView.getAttribute('data-cascade-id');
          if (cvid && /^[0-9a-f-]{36}$/i.test(cvid)) return cvid;
        }
        return '__HOME__';
      }
    }
    var view = doc.querySelector('[data-testid="conversation-view"][data-cascade-id]');
    if (view) {
      var vcid = view.getAttribute('data-cascade-id');
      if (vcid && /^[0-9a-f-]{36}$/i.test(vcid)) return vcid;
    }
    if (doc.querySelector('[data-testid="home-greeting"], .agy-home')) {
      return '__HOME__';
    }
    return null;
  }

  function scheduleDeferredTopPopoverRender() {
    if (topPopDeferredTimer) return;
    topPopDeferredTimer = setTimeout(function () {
      topPopDeferredTimer = null;
      if (!topPopoverOpen) return;
      if (topPopPointerDown || Date.now() < topPopScrollLockUntil) {
        scheduleDeferredTopPopoverRender();
        return;
      }
      renderTopPopoverContent(currentDailyUsage);
    }, 220);
  }

  function scheduleDeferredBottomPopoverRender() {
    if (bottomPopDeferredTimer) return;
    bottomPopDeferredTimer = setTimeout(function () {
      bottomPopDeferredTimer = null;
      if (!breakdownOpen) return;
      if (bottomPopPointerDown || Date.now() < bottomPopScrollLockUntil) {
        scheduleDeferredBottomPopoverRender();
        return;
      }
      renderPopoverContent(currentTelemetry);
    }, 220);
  }

  function ensurePopoverMounted() {
    if (!doc.body) return null;
    var pop = doc.getElementById('agy-hud-popover');
    if (pop && pop.parentElement === doc.body) return pop;
    if (pop && pop.parentElement) pop.parentElement.removeChild(pop);

    pop = doc.createElement('div');
    pop.id = 'agy-hud-popover';
    pop.className = 'agy-hud-popover ' + (hudTheme === 'light' ? 'agy-theme-light' : 'agy-theme-dark');
    pop.setAttribute('data-ag-localization-skip', 'true');
    pop.style.display = 'none';

    pop.addEventListener('click', function (ev) {
      ev.stopPropagation();
    });
    pop.addEventListener('wheel', function (ev) {
      bottomPopScrollLockUntil = Date.now() + 450;
      ev.stopPropagation();
    }, { passive: true });
    pop.addEventListener('scroll', function (ev) {
      bottomPopScrollLockUntil = Date.now() + 400;
      var t = ev && ev.target;
      if (t === pop) {
        savedBottomPopScrollTop = pop.scrollTop;
      } else if (t && t.id === 'agy-hud-pop-list-slot') {
        savedBottomListScrollTop = t.scrollTop;
      }
    }, true);
    pop.addEventListener('mousedown', function () {
      bottomPopPointerDown = true;
    });
    if (typeof root.PointerEvent !== 'undefined') {
      pop.addEventListener('pointerdown', function () {
        bottomPopPointerDown = true;
      });
    }

    doc.body.appendChild(pop);
    return pop;
  }

  function ensureBottomPopoverSlots(pop) {
    if (!pop) return null;
    var upperSlot = doc.getElementById('agy-hud-pop-upper-slot');
    var listSlot = doc.getElementById('agy-hud-pop-list-slot');
    if (!upperSlot || !listSlot || upperSlot.parentElement !== pop || listSlot.parentElement !== pop) {
      pop.innerHTML = '';
      upperSlot = doc.createElement('div');
      upperSlot.id = 'agy-hud-pop-upper-slot';
      listSlot = doc.createElement('div');
      listSlot.id = 'agy-hud-pop-list-slot';
      listSlot.className = 'agy-hud-pop-list';
      pop.appendChild(upperSlot);
      pop.appendChild(listSlot);
    }
    return { upperSlot: upperSlot, listSlot: listSlot };
  }

  function ensureTopPopoverMounted() {
    if (!doc.body) return null;
    var pop = doc.getElementById('agy-hud-top-popover');
    if (pop && pop.parentElement === doc.body) return pop;
    if (pop && pop.parentElement) pop.parentElement.removeChild(pop);

    pop = doc.createElement('div');
    pop.id = 'agy-hud-top-popover';
    pop.className = 'agy-hud-top-popover ' + (hudTheme === 'light' ? 'agy-theme-light' : 'agy-theme-dark');
    pop.setAttribute('data-ag-localization-skip', 'true');
    pop.style.display = 'none';

    pop.addEventListener('wheel', function (ev) {
      topPopScrollLockUntil = Date.now() + 450;
      ev.stopPropagation();
    }, { passive: true });
    pop.addEventListener('scroll', function (ev) {
      topPopScrollLockUntil = Date.now() + 400;
      var t = ev && ev.target;
      if (t === pop) {
        savedTopPopScrollTop = pop.scrollTop;
      } else if (t && t.id === 'agy-hud-model-list') {
        savedTopListScrollTop = t.scrollTop;
      }
    }, true);
    pop.addEventListener('mousedown', function () {
      topPopPointerDown = true;
    });
    if (typeof root.PointerEvent !== 'undefined') {
      pop.addEventListener('pointerdown', function () {
        topPopPointerDown = true;
      });
    }

    pop.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var target = ev.target;
      if (!target || typeof target.closest !== 'function') return;
      var themeBtn = target.closest('[data-agy-theme-toggle]');
      if (themeBtn) {
        toggleHudTheme();
        return;
      }
      var scopeBtn = target.closest('[data-agy-scope]');
      if (scopeBtn) {
        var scopeVal = scopeBtn.getAttribute('data-agy-scope');
        if (scopeVal) selectDailyScope(scopeVal);
        return;
      }
      var weekJumpBtn = target.closest('[data-agy-week-jump]');
      if (weekJumpBtn) {
        var jumpOff = Number(weekJumpBtn.getAttribute('data-agy-week-jump') || 0);
        selectWeekOffset(jumpOff);
        return;
      }
      var weekResetBtn = target.closest('[data-agy-week-reset]');
      if (weekResetBtn) {
        selectWeekOffset(0);
        return;
      }
      var weekNavBtn = target.closest('[data-agy-week-nav]');
      if (weekNavBtn && !weekNavBtn.disabled) {
        var wDir = weekNavBtn.getAttribute('data-agy-week-nav');
        if (wDir === 'prev') navigateWeekOffset(-1);
        else if (wDir === 'next') navigateWeekOffset(1);
        return;
      }
      var selectBtn = target.closest('[data-agy-date-select]');
      if (selectBtn) {
        var targetDate = selectBtn.getAttribute('data-agy-date-select');
        if (targetDate) selectDailyDate(targetDate);
        return;
      }
      var navBtn = target.closest('[data-agy-date-nav]');
      if (navBtn && !navBtn.disabled) {
        var dir = navBtn.getAttribute('data-agy-date-nav');
        if (dir === 'prev') navigateDailyDate(-1);
        else if (dir === 'next') navigateDailyDate(1);
      }
    });

    pop.addEventListener('keydown', function (ev) {
      var target = ev && ev.target;
      if (!target || typeof target.closest !== 'function') return;
      var tab = target.closest('.agy-scope-tab[data-agy-scope]');
      if (!tab) return;
      var tablist = tab.closest('.agy-scope-tabs');
      if (!tablist) return;
      var tabs = tablist.querySelectorAll('.agy-scope-tab[data-agy-scope]');
      if (!tabs || tabs.length === 0) return;
      var curIdx = -1;
      for (var i = 0; i < tabs.length; i++) {
        if (tabs[i] === tab) { curIdx = i; break; }
      }
      if (curIdx < 0) return;
      var nextIdx = -1;
      if (ev.key === 'ArrowRight') nextIdx = (curIdx + 1) % tabs.length;
      else if (ev.key === 'ArrowLeft') nextIdx = (curIdx - 1 + tabs.length) % tabs.length;
      else if (ev.key === 'Home') nextIdx = 0;
      else if (ev.key === 'End') nextIdx = tabs.length - 1;
      if (nextIdx >= 0) {
        ev.preventDefault();
        ev.stopPropagation();
        var nextScope = tabs[nextIdx].getAttribute('data-agy-scope');
        if (nextScope) {
          selectDailyScope(nextScope);
          var refreshedTabs = pop.querySelectorAll('.agy-scope-tab[data-agy-scope]');
          for (var j = 0; j < refreshedTabs.length; j++) {
            if (refreshedTabs[j].getAttribute('data-agy-scope') === nextScope && typeof refreshedTabs[j].focus === 'function') {
              try { refreshedTabs[j].focus(); } catch (_) {}
              break;
            }
          }
        }
      }
    });

    doc.body.appendChild(pop);
    return pop;
  }

  function ensureTopPopoverSlots(pop) {
    if (!pop) return null;
    var headerSlot = doc.getElementById('agy-hud-top-header-slot');
    var upperSlot = doc.getElementById('agy-hud-top-upper-slot');
    var listEl = doc.getElementById('agy-hud-model-list');
    if (!headerSlot || !upperSlot || !listEl || headerSlot.parentElement !== pop || upperSlot.parentElement !== pop || listEl.parentElement !== pop) {
      pop.innerHTML = '';
      headerSlot = doc.createElement('div');
      headerSlot.id = 'agy-hud-top-header-slot';
      upperSlot = doc.createElement('div');
      upperSlot.id = 'agy-hud-top-upper-slot';
      listEl = doc.createElement('div');
      listEl.id = 'agy-hud-model-list';
      listEl.className = 'agy-hud-model-list';
      pop.appendChild(headerSlot);
      pop.appendChild(upperSlot);
      pop.appendChild(listEl);
    }
    return { headerSlot: headerSlot, upperSlot: upperSlot, listEl: listEl };
  }

  function positionTopPopover() {
    var pop = doc.getElementById('agy-hud-top-popover');
    var btn = doc.getElementById('agy-hud-topbar-btn');
    if (!pop || !btn || !topPopoverOpen) return;

    var vw = root.innerWidth || 1024;
    var popWidth = Math.min(484, vw - 24);
    if (pop.style.top !== '32px') pop.style.top = '32px';
    if (pop.style.bottom !== 'auto') pop.style.bottom = 'auto';
    if (pop.style.right !== 'auto') pop.style.right = 'auto';

    if (typeof btn.getBoundingClientRect === 'function') {
      var rect = btn.getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0) {
        var centerX = rect.left + rect.width / 2;
        var left = Math.max(12, Math.min(centerX - popWidth / 2, vw - popWidth - 12));
        var nextLeft = Math.round(left) + 'px';
        if (pop.style.left !== nextLeft) pop.style.left = nextLeft;
        return;
      }
    }
    var fallbackLeft = Math.max(12, Math.round((vw - popWidth) / 2)) + 'px';
    if (pop.style.left !== fallbackLeft) pop.style.left = fallbackLeft;
  }

  function setTopPopoverOpen(open) {
    var nextOpen = Boolean(open);
    var pop = ensureTopPopoverMounted();
    if (!nextOpen && topPopoverOpen && pop) {
      var curList = doc.getElementById('agy-hud-model-list');
      if (curList) savedTopListScrollTop = curList.scrollTop;
      savedTopPopScrollTop = pop.scrollTop;
      topPopPointerDown = false;
    }
    topPopoverOpen = nextOpen;
    if (topPopoverOpen && breakdownOpen) {
      setPopoverOpen(false);
    }
    var btn = doc.getElementById('agy-hud-topbar-btn');
    var chev = doc.getElementById('agy-hud-top-chevron');

    if (pop) {
      pop.style.display = topPopoverOpen ? 'block' : 'none';
    }
    if (btn) {
      btn.setAttribute('aria-expanded', topPopoverOpen ? 'true' : 'false');
    }
    if (chev && chev.classList) {
      chev.classList.toggle('is-open', topPopoverOpen);
    }
    if (topPopoverOpen) {
      try { if (typeof root.CustomEvent === 'function') doc.dispatchEvent(new root.CustomEvent('agy-ncp-close-menu')); } catch (_) {}
      renderTopPopoverContent(currentDailyUsage, { userAction: true, restoreSavedScroll: true });
      positionTopPopover();
    }
  }

  function ensureTopBarMounted() {
    injectStyles();
    if (!doc.body) return null;
    ensureTopPopoverMounted();

    var topbar = doc.getElementById('agy-hud-topbar');
    if (topbar && topbar.parentElement !== doc.body) {
      if (topbar.parentElement) topbar.parentElement.removeChild(topbar);
      topbar = null;
    }

    if (!topbar) {
      topbar = doc.createElement('div');
      topbar.id = 'agy-hud-topbar';
      topbar.className = 'agy-hud-topbar ' + (hudTheme === 'light' ? 'agy-theme-light' : 'agy-theme-dark');
      topbar.setAttribute('data-ag-localization-skip', 'true');
      topbar.innerHTML = [
        '<button id="agy-hud-topbar-btn" type="button" class="agy-hud-topbar-btn" aria-expanded="' + (topPopoverOpen ? 'true' : 'false') + '" title="点击查看今日 / 近 7 天 / 累计总计 Token 消耗明细">',
        '  <span class="agy-top-badge"><span class="agy-top-status-dot"></span>今日</span>',
        '  <span id="agy-hud-top-total" class="agy-top-total">0</span>',
        '  <span id="agy-hud-top-sep" class="agy-hud-sep">·</span>',
        '  <span id="agy-hud-top-models" class="agy-top-models"><span class="agy-top-model-empty">暂无消耗</span></span>',
        '  <span id="agy-hud-top-summary" class="agy-top-summary" style="display:none"></span>',
        '  <span id="agy-hud-top-minibar" class="agy-top-minibar"></span>',
        '  <span id="agy-hud-top-chevron" class="agy-hud-chevron agy-hud-top-chevron' + (topPopoverOpen ? ' is-open' : '') + '">' + SVG_CHEVRON_10 + '</span>',
        '</button>'
      ].join('');

      var btn = topbar.querySelector('#agy-hud-topbar-btn');
      if (btn) {
        btn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          setTopPopoverOpen(!topPopoverOpen);
        });
      }

      doc.body.appendChild(topbar);
      renderTopBar(currentDailyUsage);
    }

    return topbar;
  }

  function getNavigableDates(d) {
    var map = {};
    var todayKey = (d && d.todayKey) || getLocalDateKey();
    map[todayKey] = true;
    if (d) {
      if (Array.isArray(d.availableDates)) {
        for (var i = 0; i < d.availableDates.length; i++) {
          if (d.availableDates[i]) map[String(d.availableDates[i])] = true;
        }
      }
      if (Array.isArray(d.recentDays)) {
        for (var j = 0; j < d.recentDays.length; j++) {
          if (d.recentDays[j] && d.recentDays[j].date) map[String(d.recentDays[j].date)] = true;
        }
      }
      if (d.days && typeof d.days === 'object') {
        var ks = Object.keys(d.days);
        for (var k = 0; k < ks.length; k++) {
          map[ks[k]] = true;
        }
      }
    }
    return Object.keys(map).sort();
  }

  function selectDailyDate(dateKey) {
    if (!dateKey) return;
    selectedDailyDate = String(dateKey);
    selectedDailyScope = 'day';
    renderTopPopoverContent(currentDailyUsage, { userAction: true });
    if (topPopoverOpen) {
      positionTopPopover();
    }
  }

  function selectDailyScope(scope) {
    if (scope !== 'day' && scope !== 'week' && scope !== 'total') return;
    selectedDailyScope = scope;
    renderTopPopoverContent(currentDailyUsage, { userAction: true });
    if (topPopoverOpen) {
      positionTopPopover();
    }
  }

  function selectWeekOffset(offset) {
    var nextOff = Math.min(0, Math.trunc(Number(offset || 0)));
    if (isNaN(nextOff)) nextOff = 0;
    selectedWeekOffset = nextOff;
    selectedDailyScope = 'week';
    renderTopPopoverContent(currentDailyUsage, { userAction: true });
    if (topPopoverOpen) {
      positionTopPopover();
    }
  }

  function navigateWeekOffset(delta) {
    var step = Math.trunc(Number(delta || 0));
    if (!step || isNaN(step)) return;
    var nextOff = Math.min(0, selectedWeekOffset + step);
    selectWeekOffset(nextOff);
  }

  function buildWeekInterval(d, weekOffset) {
    var todayKey = (d && d.todayKey) || getLocalDateKey();
    var offset = Math.min(0, Math.trunc(Number(weekOffset || 0)));
    if (isNaN(offset)) offset = 0;
    var endDate = shiftDateKey(todayKey, offset * 7);
    var startDate = shiftDateKey(endDate, -6);

    var recentMap = {};
    if (d && Array.isArray(d.recentDays)) {
      for (var r = 0; r < d.recentDays.length; r++) {
        var rItem = d.recentDays[r];
        if (rItem && rItem.date) recentMap[String(rItem.date)] = rItem;
      }
    }

    var intervalDays = [];
    var chartCols = [];
    var peakDay = null;

    for (var k = 6; k >= 0; k--) {
      var dKey = shiftDateKey(endDate, -k);
      var rawDay = (d && d.days && d.days[dKey]) || (dKey === todayKey && d ? d.today : null) || recentMap[dKey] || null;
      var dayEntry = normalizeDayEntry(rawDay, dKey);
      var recItem = recentMap[dKey];
      if (recItem && Number(recItem.totalTokens || 0) > dayEntry.totalTokens) {
        dayEntry.totalTokens = Number(recItem.totalTokens);
      }
      intervalDays.push(dayEntry);

      if (!peakDay || dayEntry.totalTokens > peakDay.totalTokens) {
        peakDay = dayEntry;
      }

      var topColor = (dayEntry.models && dayEntry.models[0] && dayEntry.models[0].color) ||
        (recItem && recItem.topModelColor) || '#38bdf8';
      chartCols.push({
        date: dKey,
        label: dKey.slice(5),
        isToday: dKey === todayKey,
        totalTokens: dayEntry.totalTokens,
        topModelColor: topColor,
        models: dayEntry.models || []
      });
    }

    var rawWeekly = (offset === 0 && d && d.weekly) ? d.weekly : null;
    var bucket = aggregateDaysBucket(intervalDays, rawWeekly, {
      startDate: startDate,
      endDate: endDate
    });

    var intervalTitle = offset === 0
      ? '本七日'
      : (offset === -1 ? '上一七日' : ('前 ' + Math.abs(offset) + ' 个七日'));

    return {
      offset: offset,
      startDate: startDate,
      endDate: endDate,
      intervalTitle: intervalTitle,
      intervalDays: intervalDays,
      chartCols: chartCols,
      bucket: bucket,
      peakDay: (peakDay && peakDay.totalTokens > 0) ? peakDay : null
    };
  }

  function render7dChartCols(cols, activeDate, todayKey) {
    var list = Array.isArray(cols) ? cols : [];
    var max7dTokens = 1;
    for (var i = 0; i < list.length; i++) {
      var rt = Number(list[i].totalTokens || 0);
      if (rt > max7dTokens) max7dTokens = rt;
    }
    return list.map(function (col) {
      var cTok = Number(col.totalTokens || 0);
      var fillPct = cTok > 0 ? Math.max(14, Math.min(100, Math.round(Math.pow(cTok / max7dTokens, 0.78) * 100))) : 0;
      var barColor = safeColor(col.topModelColor, '#38bdf8');
      var isColActive = Boolean(activeDate && col.date === activeDate);
      var lbl = (col.isToday || col.date === todayKey) ? '今日' : (col.label || String(col.date).slice(5));
      return '<button type="button" class="agy-7d-col' + (isColActive ? ' active' : '') + '" data-agy-date-select="' + escapeHtml(col.date) + '" title="点击查看 ' + escapeHtml(col.date) + ' 单日详情 (' + formatK(cTok) + ')">' +
        '<span class="agy-7d-val">' + (cTok > 0 ? formatK(cTok) : '-') + '</span>' +
        '<span class="agy-7d-track"><span class="agy-7d-fill" style="height:' + fillPct + '%;background:' + barColor + '"></span></span>' +
        '<span class="agy-7d-lbl">' + escapeHtml(lbl) + '</span>' +
        '</button>';
    }).join('');
  }

  function renderModelStackBarHtml(bucket) {
    var models = (bucket && Array.isArray(bucket.models)) ? bucket.models : [];
    var tot = Number((bucket && bucket.totalTokens) || 0);
    var segs = models.map(function (m) {
      var pct = Number(m.sharePct != null ? m.sharePct : (tot > 0 ? ((m.totalTokens / tot) * 100).toFixed(1) : 0)) || 0;
      return '<div class="agy-top-stack-seg" style="width:' + pct + '%;background:' + safeColor(m.color, '#60a5fa') + '" title="' + escapeHtml(m.modelName) + ': ' + pct + '%"></div>';
    }).join('');
    return '<div class="agy-top-stack-bar" style="display:' + (models.length > 1 ? 'flex' : 'none') + '" title="当前统计维度各模型 Token 消耗占比">' + segs + '</div>';
  }

  function renderModelRowInnerHtml(m, tot) {
    var pct = Number(m.sharePct != null ? m.sharePct : (tot > 0 ? ((m.totalTokens / tot) * 100).toFixed(1) : 0)) || 0;
    var barW = Math.max(2, Math.min(100, pct));
    var color = safeColor(m.color, '#60a5fa');
    var hitRate = Number(m.cacheHitRate || 0);
    var thinkPart = Number(m.thinkingTokens || 0) > 0 ? (' · 思考 ' + formatK(m.thinkingTokens)) : '';
    return '<div class="agy-top-model-head">' +
      '  <div class="agy-top-model-left"><span class="agy-top-dot" style="background:' + color + '"></span> <strong>' + escapeHtml(m.modelName) + '</strong> <span class="agy-model-turns">' + Number(m.turnCount || 0) + ' 轮</span></div>' +
      '  <div class="agy-top-model-right"><span class="agy-model-pct">' + pct + '%</span> <span class="agy-model-total">' + formatK(m.totalTokens) + '</span></div>' +
      '</div>' +
      '<div class="agy-top-model-bar">' +
      '  <div style="width:' + barW.toFixed(1) + '%;background:' + color + ';height:100%"></div>' +
      '</div>' +
      '<div class="agy-top-model-meta">输入 ' + formatK(m.inputTokens) + ' · 缓存 ' + formatK(m.cacheReadTokens) + ' (' + hitRate + '%) · 输出 ' + formatK(m.outputTokens) + thinkPart + '</div>';
  }

  function renderModelListHtml(bucket, emptyMsg) {
    var models = (bucket && Array.isArray(bucket.models)) ? bucket.models : [];
    var tot = Number((bucket && bucket.totalTokens) || 0);
    if (models.length === 0) {
      return '<div class="agy-top-empty-state">' + escapeHtml(emptyMsg || '当前统计维度暂无模型 Token 消耗记录') + '</div>';
    }
    return models.map(function (m) {
      return '<div class="agy-top-model-row" data-agy-model-key="' + escapeHtml(m.modelName) + '">' +
        renderModelRowInnerHtml(m, tot) +
        '</div>';
    }).join('');
  }

  function patchModelListDom(listEl, bucket, nextModelHtml, viewChanged) {
    if (!listEl) return;
    if (!viewChanged && listEl.__agyHtml === nextModelHtml && listEl.childNodes.length > 0) {
      return;
    }
    var models = (bucket && Array.isArray(bucket.models)) ? bucket.models : [];
    var tot = Number((bucket && bucket.totalTokens) || 0);
    if (!viewChanged && models.length > 0 && listEl.children && listEl.children.length === models.length) {
      var sameKeys = true;
      for (var i = 0; i < models.length; i++) {
        var child = listEl.children[i];
        if (!child || child.getAttribute('data-agy-model-key') !== String(models[i].modelName || '')) {
          sameKeys = false;
          break;
        }
      }
      if (sameKeys) {
        for (var j = 0; j < models.length; j++) {
          setHtmlIfChanged(listEl.children[j], renderModelRowInnerHtml(models[j], tot));
        }
        listEl.__agyHtml = nextModelHtml;
        return;
      }
    }
    listEl.innerHTML = nextModelHtml;
    listEl.__agyHtml = nextModelHtml;
    if (models.length > 0 && listEl.children && listEl.children.length === models.length) {
      for (var k = 0; k < models.length; k++) {
        listEl.children[k].__agyHtml = renderModelRowInnerHtml(models[k], tot);
      }
    }
  }

  function navigateDailyDate(delta) {
    var d = currentDailyUsage || normalizeDailyUsage(null);
    var todayKey = d.todayKey || getLocalDateKey();
    var cur = selectedDailyDate || todayKey;
    var navDates = getNavigableDates(d);
    var idx = navDates.indexOf(cur);

    if (delta < 0) {
      if (idx > 0) {
        selectDailyDate(navDates[idx - 1]);
      } else {
        selectDailyDate(shiftDateKey(cur, -1));
      }
    } else if (delta > 0) {
      if (cur >= todayKey) return;
      if (idx >= 0 && idx < navDates.length - 1) {
        var nextCandidate = navDates[idx + 1];
        selectDailyDate(nextCandidate > todayKey ? todayKey : nextCandidate);
      } else {
        var shifted = shiftDateKey(cur, 1);
        selectDailyDate(shifted > todayKey ? todayKey : shifted);
      }
    }
  }

  function updateDailyUsage(rawDaily, fallbackData) {
    var normalized = rawDaily
      ? normalizeDailyUsage(rawDaily)
      : (fallbackData ? synthesizeFallbackDailyUsage(fallbackData) : normalizeDailyUsage(null));
    var prevTodayKey = lastKnownTodayKey;
    currentDailyUsage = normalized;
    lastKnownTodayKey = normalized.todayKey;

    if (!selectedDailyDate || selectedDailyDate === prevTodayKey) {
      selectedDailyDate = normalized.todayKey;
    }

    renderTopBar(currentDailyUsage);
  }

  function renderTopBar(daily) {
    var topbar = ensureTopBarMounted();
    if (!topbar) return;

    var d = daily || currentDailyUsage || normalizeDailyUsage(null);
    var todayKey = d.todayKey || getLocalDateKey();
    var today = d.today || (d.days && d.days[todayKey]) || createEmptyDayEntry(todayKey);
    var weekly = d.weekly || { totalTokens: today.totalTokens };
    var grand = d.grandTotal || { totalTokens: today.totalTokens };

    var totalEl = doc.getElementById('agy-hud-top-total');
    var modelsEl = doc.getElementById('agy-hud-top-models');
    var summaryEl = doc.getElementById('agy-hud-top-summary');
    var minibarEl = doc.getElementById('agy-hud-top-minibar');

    var totalTok = Number(today.totalTokens || 0);
    setText(totalEl, totalTok > 0 ? formatK(totalTok) : '0');

    var models = Array.isArray(today.models) ? today.models : [];
    if (modelsEl) {
      if (models.length > 0 && totalTok > 0) {
        var top3 = models.slice(0, 3);
        var chipsHtml = top3.map(function (m) {
          var color = safeColor(m.color, '#60a5fa');
          var shortLabel = escapeHtml(m.shortLabel || m.modelName || 'Model');
          return '<span class="agy-top-model-chip">' +
            '<span class="agy-top-dot" style="background:' + color + '"></span>' +
            '<span class="agy-top-model-name">' + shortLabel + '</span>' +
            '<span class="agy-top-model-val">' + formatK(m.totalTokens) + '</span>' +
            '</span>';
        }).join('');
        if (models.length > 3) {
          chipsHtml += '<span class="agy-top-more">+' + (models.length - 3) + '</span>';
        }
        setHtmlIfChanged(modelsEl, chipsHtml);
      } else {
        setHtmlIfChanged(modelsEl, '<span class="agy-top-model-empty">暂无消耗</span>');
      }
    }

    var weekTok = Number(weekly.totalTokens || 0);
    var grandTok = Number(grand.totalTokens || 0);
    if (summaryEl) {
      if (weekTok > 0 || grandTok > 0) {
        setDisplay(summaryEl, '');
        setText(summaryEl, '7D ' + formatK(weekTok) + ' · 总 ' + formatK(grandTok));
      } else {
        setDisplay(summaryEl, 'none');
        setText(summaryEl, '');
      }
    }

    if (minibarEl) {
      if (models.length > 0 && totalTok > 0) {
        setHtmlIfChanged(minibarEl, models.map(function (m) {
          var pct = Number(m.sharePct != null ? m.sharePct : (totalTok > 0 ? ((m.totalTokens / totalTok) * 100).toFixed(1) : 0)) || 0;
          var color = safeColor(m.color, '#60a5fa');
          return '<span style="width:' + pct + '%;background:' + color + ';height:100%"></span>';
        }).join(''));
      } else {
        setHtmlIfChanged(minibarEl, '');
      }
    }

    if (topPopoverOpen) {
      renderTopPopoverContent(d);
      positionTopPopover();
    }
  }

  function renderTopPopoverContent(daily, options) {
    var pop = ensureTopPopoverMounted();
    if (!pop) return;
    var isUserAction = Boolean(options && options.userAction);

    var d = daily || currentDailyUsage || normalizeDailyUsage(null);
    var todayKey = d.todayKey || getLocalDateKey();
    var date = selectedDailyDate || todayKey;
    var scope = selectedDailyScope || 'day';
    var viewKey = scope + '|' + date + '|' + (scope === 'week' ? selectedWeekOffset : 0);
    var viewChanged = topPopLastViewKey !== viewKey;

    var rawDay = (d.days && d.days[date]) || (date === todayKey ? d.today : null);
    if (!rawDay && Array.isArray(d.recentDays)) {
      for (var r = 0; r < d.recentDays.length; r++) {
        if (d.recentDays[r] && d.recentDays[r].date === date) {
          rawDay = d.recentDays[r];
          break;
        }
      }
    }
    var day = normalizeDayEntry(rawDay, date);
    var grand = d.grandTotal || aggregateDaysBucket([day], null, null);

    var isToday = date === todayKey;
    var isLatest = date >= todayKey;

    var isDark = hudTheme === 'dark';
    var themeIconSvg = isDark
      ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>'
      : '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
    var themeBtnTitle = isDark ? '当前深色风格，点击切换为白色风格' : '当前白色风格，点击切换为深色风格';
    var themeBtnText = isDark ? '深色' : '浅色';

    var headerHtml = [
      '<div class="agy-top-pop-header">',
      '  <div class="agy-top-header-left">',
      '    <span class="agy-top-pop-title">Token 用量看板</span>',
      '  </div>',
      '  <div class="agy-top-header-right">',
      '    <div class="agy-scope-tabs" role="tablist">',
      '      <button type="button" role="tab" tabindex="' + (scope === 'day' ? '0' : '-1') + '" aria-selected="' + (scope === 'day' ? 'true' : 'false') + '" class="agy-scope-tab' + (scope === 'day' ? ' active' : '') + '" data-agy-scope="day">单日</button>',
      '      <button type="button" role="tab" tabindex="' + (scope === 'week' ? '0' : '-1') + '" aria-selected="' + (scope === 'week' ? 'true' : 'false') + '" class="agy-scope-tab' + (scope === 'week' ? ' active' : '') + '" data-agy-scope="week">7 日</button>',
      '      <button type="button" role="tab" tabindex="' + (scope === 'total' ? '0' : '-1') + '" aria-selected="' + (scope === 'total' ? 'true' : 'false') + '" class="agy-scope-tab' + (scope === 'total' ? ' active' : '') + '" data-agy-scope="total">总计</button>',
      '    </div>',
      '    <button type="button" class="agy-theme-toggle-btn" data-agy-theme-toggle="true" title="' + themeBtnTitle + '">' + themeIconSvg + '<span>' + themeBtnText + '</span></button>',
      '  </div>',
      '</div>'
    ].join('');

    var upperHtml = '';
    var activeBucket = day;
    var activeEmptyMsg = '该日期暂无模型 Token 消耗记录';

    if (scope === 'week') {
      var weekInfo = buildWeekInterval(d, selectedWeekOffset);
      var weekBucket = weekInfo.bucket;
      var wOffset = weekInfo.offset;
      var startDate = weekInfo.startDate;
      var endDate = weekInfo.endDate;
      var peakDay = weekInfo.peakDay;
      var weekAvg = Math.round(Number(weekBucket.totalTokens || 0) / Math.max(1, Number(weekBucket.dayCount || 1)));

      activeBucket = weekBucket;
      activeEmptyMsg = '该七日区间暂无模型 Token 消耗记录';
      upperHtml = [
        '<div class="agy-page-bar">',
        '  <span class="agy-page-bar-title">七日区间统计 · <span class="agy-sec-sub">' + escapeHtml(weekInfo.intervalTitle) + '</span></span>',
        '  <div class="agy-top-nav-cluster">',
        '    <button type="button" class="agy-top-nav-btn agy-nav-wide" data-agy-week-nav="prev" title="查看上一个七日区间" aria-label="上一七日">‹ 上七日</button>',
        '    <span id="agy-hud-week-label" class="agy-top-date-label">' + escapeHtml(startDate.slice(5) + ' ~ ' + endDate.slice(5)) + '</span>',
        '    <button type="button" class="agy-top-nav-btn agy-nav-wide" data-agy-week-nav="next" title="查看下一个七日区间" aria-label="下一七日"' + (wOffset >= 0 ? ' disabled' : '') + '>下七日 ›</button>',
        (wOffset < 0 ? '    <button type="button" class="agy-top-nav-today" data-agy-week-reset="true">回本七日</button>' : ''),
        '  </div>',
        '</div>',
        '<div class="agy-kpi-strip">',
        '  <div class="agy-kpi-card">',
        '    <span class="agy-kpi-lbl">七日区间总消耗</span>',
        '    <span class="agy-kpi-val">' + formatK(weekBucket.totalTokens) + '</span>',
        '    <span class="agy-kpi-sub">活跃 ' + Number(weekBucket.dayCount || 0) + '/7 天 · ' + Number(weekBucket.turnCount || 0) + ' 轮</span>',
        '  </div>',
        '  <div class="agy-kpi-card">',
        '    <span class="agy-kpi-lbl">区间日均与峰值</span>',
        '    <span class="agy-kpi-val">' + formatK(weekAvg) + '/日</span>',
        '    <span class="agy-kpi-sub">' + (peakDay && peakDay.totalTokens > 0 ? ('峰值 ' + escapeHtml(peakDay.date.slice(5)) + ' (' + formatK(peakDay.totalTokens) + ')') : '区间内无峰值记录') + '</span>',
        '  </div>',
        '  <div class="agy-kpi-card">',
        '    <span class="agy-kpi-lbl">区间缓存命中率</span>',
        '    <span class="agy-kpi-val">' + Number(weekBucket.cacheHitRate || 0) + '%</span>',
        '    <span class="agy-kpi-sub">缓 ' + formatK(weekBucket.cacheReadTokens) + ' · 入 ' + formatK(weekBucket.inputTokens) + '</span>',
        '  </div>',
        '</div>',
        '<div class="agy-hud-pop-section-title">',
        '  <span>区间逐日趋势 (' + escapeHtml(startDate.slice(5) + ' ~ ' + endDate.slice(5)) + ')</span>',
        '  <span class="agy-sec-hint">点击任意单日可下钻查看</span>',
        '</div>',
        '<div id="agy-hud-7d-chart" class="agy-hud-7d-chart">',
        render7dChartCols(weekInfo.chartCols, null, todayKey),
        '</div>',
        renderModelStackBarHtml(weekBucket),
        '<div class="agy-hud-pop-section-title">',
        '  <span>该七日模型消耗排行 (' + weekBucket.models.length + ')</span>',
        '  <span>Σ ' + formatK(weekBucket.totalTokens) + '</span>',
        '</div>'
      ].join('');
    } else if (scope === 'total') {
      var navDates = getNavigableDates(d);
      var firstDate = navDates.length > 0 ? navDates[0] : todayKey;
      var peakHistoricalDay = null;
      var maxAllTimeDayTokens = 1;
      for (var di = 0; di < navDates.length; di++) {
        var dk = navDates[di];
        var rawHist = (d.days && d.days[dk]) || (dk === todayKey ? d.today : null);
        var dObj = rawHist ? normalizeDayEntry(rawHist, dk) : null;
        if (dObj && dObj.totalTokens > 0) {
          if (dObj.totalTokens > maxAllTimeDayTokens) {
            maxAllTimeDayTokens = dObj.totalTokens;
          }
          if (!peakHistoricalDay || dObj.totalTokens > peakHistoricalDay.totalTokens) {
            peakHistoricalDay = dObj;
          }
        }
      }

      var activeDaysCount = Math.max(1, Number(grand.dayCount || (grand.totalTokens > 0 ? 1 : 0) || 1));
      var grandDailyAvg = Math.round(Number(grand.totalTokens || 0) / activeDaysCount);

      var hmRows = [];
      for (var wOff = -3; wOff <= 0; wOff++) {
        var wInfo = buildWeekInterval(d, wOff);
        var wTag = wOff === 0 ? '本七日' : (wOff === -1 ? '上七日' : (Math.abs(wOff) + '周前'));
        var cellsHtml = wInfo.intervalDays.map(function (dEntry) {
          var cellTok = Number(dEntry.totalTokens || 0);
          var lvl = 0;
          if (cellTok > 0) {
            var ratio = cellTok / maxAllTimeDayTokens;
            lvl = ratio >= 0.75 ? 4 : (ratio >= 0.45 ? 3 : (ratio >= 0.18 ? 2 : 1));
          }
          var todayCls = dEntry.date === todayKey ? ' is-today' : '';
          return '<button type="button" class="agy-hm-cell level-' + lvl + todayCls + '" data-agy-date-select="' + escapeHtml(dEntry.date) + '" title="' + escapeHtml(dEntry.date) + ': ' + formatK(cellTok) + ' (' + Number(dEntry.turnCount || 0) + ' 轮)">' + escapeHtml(dEntry.date.slice(8)) + '</button>';
        }).join('');

        hmRows.push(
          '<div class="agy-hm-row">' +
          '  <button type="button" class="agy-hm-week-btn" data-agy-week-jump="' + wOff + '" title="点击切换到该七日区间视图 (' + escapeHtml(wInfo.startDate + ' ~ ' + wInfo.endDate) + ')">' +
          '    <span class="agy-hm-week-tag">' + escapeHtml(wTag) + '</span>' +
          '    <span class="agy-hm-week-range">' + escapeHtml(wInfo.startDate.slice(5) + '~' + wInfo.endDate.slice(5)) + '</span>' +
          '  </button>' +
          '  <div class="agy-hm-cells">' + cellsHtml + '</div>' +
          '  <span class="agy-hm-week-val">' + (wInfo.bucket.totalTokens > 0 ? formatK(wInfo.bucket.totalTokens) : '-') + '</span>' +
          '</div>'
        );
      }

      activeBucket = grand;
      activeEmptyMsg = '暂无历史模型 Token 消耗记录';
      upperHtml = [
        '<div class="agy-page-bar">',
        '  <span class="agy-page-bar-title">全周期累计看板</span>',
        '  <span class="agy-lifecycle-pill">' + escapeHtml(firstDate + ' ~ ' + todayKey) + ' · 累计活跃 ' + activeDaysCount + ' 天</span>',
        '</div>',
        '<div class="agy-kpi-grid-4">',
        '  <div class="agy-kpi-card">',
        '    <span class="agy-kpi-lbl">历史累计总消耗</span>',
        '    <span class="agy-kpi-val">' + formatK(grand.totalTokens) + '</span>',
        '    <span class="agy-kpi-sub">日均 ' + formatK(grandDailyAvg) + ' · ' + Number(grand.sessionCount || 0) + ' 会话</span>',
        '  </div>',
        '  <div class="agy-kpi-card">',
        '    <span class="agy-kpi-lbl">历史最高单日</span>',
        '    <span class="agy-kpi-val">' + (peakHistoricalDay ? formatK(peakHistoricalDay.totalTokens) : '0') + '</span>',
        '    <span class="agy-kpi-sub">' + (peakHistoricalDay ? (escapeHtml(peakHistoricalDay.date) + ' · ' + Number(peakHistoricalDay.turnCount || 0) + ' 轮') : '暂无记录') + '</span>',
        '  </div>',
        '  <div class="agy-kpi-card">',
        '    <span class="agy-kpi-lbl">全局缓存命中率</span>',
        '    <span class="agy-kpi-val">' + Number(grand.cacheHitRate || 0) + '%</span>',
        '    <span class="agy-kpi-sub">缓 ' + formatK(grand.cacheReadTokens) + ' · 入 ' + formatK(grand.inputTokens) + '</span>',
        '  </div>',
        '  <div class="agy-kpi-card">',
        '    <span class="agy-kpi-lbl">累计输出与思考</span>',
        '    <span class="agy-kpi-val">' + formatK(grand.outputTokens) + '</span>',
        '    <span class="agy-kpi-sub">思考 ' + formatK(grand.thinkingTokens || 0) + ' · ' + Number(grand.turnCount || 0) + ' 轮</span>',
        '  </div>',
        '</div>',
        '<div class="agy-hud-pop-section-title">',
        '  <span>近 4 个七日周期热力分布 (28 天)</span>',
        '  <span class="agy-sec-hint">点击周期跳转 7 日视图 · 点击方格查看单日</span>',
        '</div>',
        '<div id="agy-hud-total-heatmap" class="agy-hud-total-heatmap">',
        hmRows.join(''),
        '</div>',
        renderModelStackBarHtml(grand),
        '<div class="agy-hud-pop-section-title">',
        '  <span>历史累计模型总榜 (' + grand.models.length + ')</span>',
        '  <span>入 ' + formatK(grand.inputTokens) + ' · 缓 ' + formatK(grand.cacheReadTokens) + ' · 出 ' + formatK(grand.outputTokens) + '</span>',
        '</div>'
      ].join('');
    } else {
      var recent = (Array.isArray(d.recentDays) && d.recentDays.length > 0)
        ? d.recentDays
        : buildWeekInterval(d, 0).chartCols;

      activeBucket = day;
      activeEmptyMsg = '该日期暂无模型 Token 消耗记录';
      upperHtml = [
        '<div class="agy-page-bar">',
        '  <span class="agy-page-bar-title">单日消耗概览 · <span class="agy-sec-sub">' + escapeHtml(isToday ? '今日实时' : '历史单日') + '</span></span>',
        '  <div class="agy-top-nav-cluster">',
        '    <button type="button" class="agy-top-nav-btn" data-agy-date-nav="prev" title="前一天" aria-label="前一天">‹</button>',
        '    <span id="agy-hud-date-label" class="agy-top-date-label">' + escapeHtml(isToday ? ('今日 ' + date.slice(5)) : date) + '</span>',
        '    <button type="button" class="agy-top-nav-btn" data-agy-date-nav="next" title="后一天" aria-label="后一天"' + (isLatest ? ' disabled' : '') + '>›</button>',
        (!isToday ? ('    <button type="button" class="agy-top-nav-today" data-agy-date-select="' + escapeHtml(todayKey) + '">回今日</button>') : ''),
        '  </div>',
        '</div>',
        '<div class="agy-kpi-strip">',
        '  <div class="agy-kpi-card">',
        '    <span class="agy-kpi-lbl">当日总消耗</span>',
        '    <span class="agy-kpi-val">' + formatK(day.totalTokens) + '</span>',
        '    <span class="agy-kpi-sub">' + Number(day.turnCount || 0) + ' 轮推理 · ' + Number(day.sessionCount || 0) + ' 个会话</span>',
        '  </div>',
        '  <div class="agy-kpi-card">',
        '    <span class="agy-kpi-lbl">缓存命中率</span>',
        '    <span class="agy-kpi-val">' + Number(day.cacheHitRate || 0) + '%</span>',
        '    <span class="agy-kpi-sub">缓 ' + formatK(day.cacheReadTokens) + ' · 入 ' + formatK(day.inputTokens) + '</span>',
        '  </div>',
        '  <div class="agy-kpi-card">',
        '    <span class="agy-kpi-lbl">输出与思考</span>',
        '    <span class="agy-kpi-val">' + formatK(day.outputTokens) + '</span>',
        '    <span class="agy-kpi-sub">思考 ' + formatK(day.thinkingTokens || 0) + ' · ' + day.models.length + ' 个模型</span>',
        '  </div>',
        '</div>',
        '<div class="agy-hud-pop-section-title">',
        '  <span>近 7 日快速切换</span>',
        '  <span class="agy-sec-hint">点击柱体查看对应日期</span>',
        '</div>',
        '<div id="agy-hud-7d-chart" class="agy-hud-7d-chart">',
        render7dChartCols(recent, date, todayKey),
        '</div>',
        renderModelStackBarHtml(day),
        '<div class="agy-hud-pop-section-title">',
        '  <span>当日模型明细 (' + day.models.length + ')</span>',
        '  <span>入 ' + formatK(day.inputTokens) + ' · 缓 ' + formatK(day.cacheReadTokens) + ' · 出 ' + formatK(day.outputTokens) + '</span>',
        '</div>'
      ].join('');
    }

    var nextModelHtml = renderModelListHtml(activeBucket, activeEmptyMsg);
    var slots = ensureTopPopoverSlots(pop);
    if (!slots) return;

    if (!viewChanged &&
        slots.headerSlot.__agyHtml === headerHtml &&
        slots.upperSlot.__agyHtml === upperHtml &&
        slots.listEl.__agyHtml === nextModelHtml &&
        slots.listEl.childNodes.length > 0) {
      return;
    }

    if (!isUserAction && !viewChanged && (topPopPointerDown || Date.now() < topPopScrollLockUntil)) {
      scheduleDeferredTopPopoverRender();
      return;
    }

    var restoreSaved = Boolean(options && options.restoreSavedScroll);
    var prevListScroll = viewChanged ? 0 : (restoreSaved ? savedTopListScrollTop : slots.listEl.scrollTop);
    var prevPopScroll = viewChanged ? 0 : (restoreSaved ? savedTopPopScrollTop : pop.scrollTop);

    setHtmlIfChanged(slots.headerSlot, headerHtml);
    setHtmlIfChanged(slots.upperSlot, upperHtml);
    patchModelListDom(slots.listEl, activeBucket, nextModelHtml, viewChanged);

    if (viewChanged) {
      savedTopListScrollTop = 0;
      savedTopPopScrollTop = 0;
      if (slots.listEl.scrollTop !== 0) slots.listEl.scrollTop = 0;
      if (pop.scrollTop !== 0) pop.scrollTop = 0;
    } else {
      if (slots.listEl.scrollTop !== prevListScroll) slots.listEl.scrollTop = prevListScroll;
      if (pop.scrollTop !== prevPopScroll) pop.scrollTop = prevPopScroll;
      savedTopListScrollTop = slots.listEl.scrollTop;
      savedTopPopScrollTop = pop.scrollTop;
    }
    topPopLastViewKey = viewKey;
  }

  function positionPopover() {
    var pop = doc.getElementById('agy-hud-popover');
    var btn = doc.getElementById('agy-hud-toggle-btn');
    if (!pop || !btn || !breakdownOpen) return;

    if (typeof btn.getBoundingClientRect !== 'function') return;
    var rect = btn.getBoundingClientRect();
    var vw = root.innerWidth || 1024;
    var vh = root.innerHeight || 768;
    var popWidth = Math.min(396, vw - 24);

    if (rect.width === 0 && rect.height === 0) {
      pop.style.right = '16px';
      pop.style.bottom = '56px';
      pop.style.left = 'auto';
      pop.style.top = 'auto';
      return;
    }

    var left = Math.max(12, Math.min(rect.right - popWidth, vw - popWidth - 12));
    pop.style.left = Math.round(left) + 'px';
    pop.style.right = 'auto';

    if (rect.top > 260) {
      pop.style.bottom = Math.round(vh - rect.top + 8) + 'px';
      pop.style.top = 'auto';
    } else {
      pop.style.top = Math.round(rect.bottom + 8) + 'px';
      pop.style.bottom = 'auto';
    }
  }

  function setPopoverOpen(open) {
    var nextOpen = Boolean(open);
    var pop = ensurePopoverMounted();
    if (!nextOpen && breakdownOpen && pop) {
      var curList = doc.getElementById('agy-hud-pop-list-slot');
      if (curList) savedBottomListScrollTop = curList.scrollTop;
      savedBottomPopScrollTop = pop.scrollTop;
      bottomPopPointerDown = false;
    }
    breakdownOpen = nextOpen;
    if (breakdownOpen && topPopoverOpen) {
      setTopPopoverOpen(false);
    }
    var btn = doc.getElementById('agy-hud-toggle-btn');
    var chev = doc.getElementById('agy-hud-chevron');

    if (pop) {
      pop.style.display = breakdownOpen ? 'block' : 'none';
    }
    if (btn) {
      btn.setAttribute('aria-expanded', breakdownOpen ? 'true' : 'false');
    }
    if (chev && chev.classList) {
      chev.classList.toggle('is-open', breakdownOpen);
    }
    if (breakdownOpen) {
      try { if (typeof root.CustomEvent === 'function') doc.dispatchEvent(new root.CustomEvent('agy-ncp-close-menu')); } catch (_) {}
      renderPopoverContent(currentTelemetry, { userAction: true, restoreSavedScroll: true });
      positionPopover();
    }
  }

  function ensureInputBarMounted() {
    injectStyles();
    ensurePopoverMounted();
    ensureTopBarMounted();

    var footer = findComposerFooter();
    if (!footer) {
      var staleCluster = doc.getElementById('agy-hud-footer-cluster');
      if (staleCluster && staleCluster.parentElement) {
        staleCluster.parentElement.removeChild(staleCluster);
      }
      if (breakdownOpen) {
        setPopoverOpen(false);
      }
      return null;
    }

    var cluster = doc.getElementById('agy-hud-footer-cluster');
    if (cluster && cluster.parentElement !== footer) {
      if (cluster.parentElement) cluster.parentElement.removeChild(cluster);
      cluster = null;
    }

    if (!cluster) {
      cluster = doc.createElement('div');
      cluster.id = 'agy-hud-footer-cluster';
      cluster.className = 'agy-hud-footer-cluster ' + (hudTheme === 'light' ? 'agy-theme-light' : 'agy-theme-dark');
      cluster.setAttribute('data-ag-localization-skip', 'true');
      cluster.innerHTML = [
        '<button id="agy-hud-toggle-btn" type="button" class="agy-hud-pill-btn" aria-expanded="' + (breakdownOpen ? 'true' : 'false') + '" title="点击查看当前会话上下文构成与步骤耗时">',
        '  <svg class="agy-hud-ring" width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">',
        '    <circle class="agy-hud-ring-track" cx="7" cy="7" r="5" fill="none" stroke-width="2"></circle>',
        '    <circle id="agy-hud-ring-arc" class="agy-hud-ring-arc" cx="7" cy="7" r="5" fill="none" stroke-width="2" stroke-dasharray="31.42" stroke-dashoffset="31.42" stroke-linecap="round" transform="rotate(-90 7 7)"></circle>',
        '  </svg>',
        '  <span id="agy-hud-ctx-text" class="agy-hud-ctx-text">0 / ' + formatLimitK(getIdleContextLimit()) + '</span>',
        '  <span id="agy-hud-sep-1" class="agy-hud-sep">·</span>',
        '  <span id="agy-hud-cache-text" class="agy-hud-sub-text">缓 --%</span>',
        '  <span id="agy-hud-sep-2" class="agy-hud-sep">·</span>',
        '  <span id="agy-hud-speed-text" class="agy-hud-speed-text">' + SVG_BOLT_11 + '<span id="agy-hud-speed-val">--/s</span></span>',
        '  <span id="agy-hud-chevron" class="agy-hud-chevron' + (breakdownOpen ? ' is-open' : '') + '">' + SVG_CHEVRON_10 + '</span>',
        '</button>'
      ].join('');

      var btn = cluster.querySelector('#agy-hud-toggle-btn');
      if (btn) {
        btn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          setPopoverOpen(!breakdownOpen);
        });
      }
    }

    // Mount immediately before the right-hand cluster (Turbo / Send buttons) inside .agy-composer-footer.
    // The footer is owned by the app's UI framework; guard every DOM write so a concurrent
    // re-render can never throw out of here (we simply retry on the next sync tick).
    try {
      if (footer.children.length >= 2) {
        var rightCluster = footer.lastElementChild;
        if (rightCluster !== cluster && (cluster.parentElement !== footer || cluster.nextElementSibling !== rightCluster)) {
          footer.insertBefore(cluster, rightCluster);
        }
      } else if (cluster.parentElement !== footer) {
        footer.appendChild(cluster);
      }
    } catch (_) {
      return null;
    }

    return cluster;
  }

  function renderPopoverContent(data, options) {
    var pop = ensurePopoverMounted();
    if (!pop) return;
    var isUserAction = Boolean(options && options.userAction);
    var slots = ensureBottomPopoverSlots(pop);
    if (!slots) return;

    if (!data || activeCascadeId === '__HOME__' || (!Number(data.currentContext || 0) && !Number(data.stepCount || 0) && !Number(data.plannerStepCount || 0) && (!data.steps || data.steps.length === 0))) {
      var emptyUpperHtml = [
        '<div class="agy-hud-pop-header">',
        '  <span class="agy-hud-pop-title">' + SVG_CHART_13 + '<span>上下文与速率监控</span></span>',
        '  <span class="agy-hud-pop-badge">新建会话</span>',
        '</div>',
        '<div class="agy-pop-empty-note">当前处于新建会话或暂无模型步骤记录。发送消息或点击左侧任意历史会话后，此处将实时展示该会话的上下文水位、缓存命中率与高消耗步骤排行。</div>'
      ].join('');
      setHtmlIfChanged(slots.upperSlot, emptyUpperHtml);
      setHtmlIfChanged(slots.listSlot, '');
      setDisplay(slots.listSlot, 'none');
      bottomPopLastConvKey = '__EMPTY__';
      savedBottomListScrollTop = 0;
      savedBottomPopScrollTop = 0;
      return;
    }

    var convKey = String(data.conversationId || activeCascadeId || 'active');
    var convChanged = bottomPopLastConvKey !== convKey;

    var curCtx = Number(data.currentContext || 0);
    var peakCtx = Number(data.peakContext || curCtx);
    var limitCtx = Number(data.contextLimit || getIdleContextLimit() || 256000);
    var pct = Number(data.contextUsagePct || ((curCtx / limitCtx) * 100).toFixed(1));
    var compactions = Number(data.compactionCount || 0);
    var latestCacheTok = Number(data.latestCacheReadTokens || 0);
    var latestInTok = Number(data.latestInputTokens || 0);
    var latestCacheRate = Number(data.latestCacheHitRate || 0);
    var latestSpeed = Number(data.latestTokPerSec || 0);
    var avgSpeed = Number(data.avgTokPerSec || 0);
    var latestDur = Number(data.latestDurationSec || 0);
    var totalModel = Number(data.totalModelSec || 0);
    var totalTool = Number(data.totalToolSec || 0);
    var totalOutTok = Number(data.totalOutputTokens || 0);
    var totalInTok = Number(data.totalInputTokens || 0);
    var totalCacheTok = Number(data.totalCacheReadTokens || 0);
    var totalTok = Number(data.totalTokens || (totalInTok + totalCacheTok + totalOutTok));
    var plannerSteps = Number(data.plannerStepCount || 0);

    var scale = Math.max(curCtx, 1);
    var cW = Math.min(100, (latestCacheTok / scale) * 100);
    var nW = Math.min(100 - cW, (latestInTok / scale) * 100);

    var consumers = (data.topConsumers || []).slice(0, 5);
    var rowsHtml = consumers.map(function (c, idx) {
      return '<div class="agy-hud-pop-row">' +
        '<span class="agy-hud-pop-row-label" title="' + escapeHtml(c.label) + '">' + (idx + 1) + '. Step #' + Number(c.stepIndex || 0) + ' · ' + escapeHtml(c.label) + '</span>' +
        '<span class="agy-hud-pop-row-val">+' + Number(c.deltaTokens || 0).toLocaleString() + '</span>' +
        '</div>';
    }).join('');
    var nextListHtml = rowsHtml || '<div class="agy-pop-empty-note">暂无增量记录</div>';

    var compactSuffix = compactions > 0 ? (' · 已压缩 ' + compactions + ' 次') : '';
    var peakNote = peakCtx > curCtx + 10000
      ? ('峰值 ' + formatK(peakCtx) + ' / ' + formatLimitK(limitCtx) + compactSuffix)
      : ('上限 ' + formatLimitK(limitCtx) + (data.isEstimated ? ' · 历史估算' : ' · 精确计量') + compactSuffix);

    var shortId = data.conversationId ? String(data.conversationId).slice(0, 8) : '当前会话';

    var upperHtml = [
      '<div class="agy-hud-pop-header">',
      '  <span class="agy-hud-pop-title">' + SVG_CHART_13 + '<span>会话上下文构成拆解</span></span>',
      '  <span class="agy-hud-pop-badge">#' + escapeHtml(shortId) + ' · 共 ' + plannerSteps + ' 步</span>',
      '</div>',
      '<div class="agy-hud-pop-grid">',
      '  <div class="agy-hud-pop-card">',
      '    <div class="agy-hud-pop-card-label">当前上下文水位</div>',
      '    <div class="agy-hud-pop-card-val">' + formatK(curCtx) + ' <span class="agy-val-muted">(' + pct + '%)</span></div>',
      '    <div class="agy-hud-pop-card-sub">' + peakNote + '</div>',
      '  </div>',
      '  <div class="agy-hud-pop-card">',
      '    <div class="agy-hud-pop-card-label">Prompt 缓存命中率</div>',
      '    <div class="agy-hud-pop-card-val agy-val-emerald">' + latestCacheRate + '%</div>',
      '    <div class="agy-hud-pop-card-sub">命中 ' + formatK(latestCacheTok) + ' · 新增 +' + formatK(latestInTok) + '</div>',
      '  </div>',
      '  <div class="agy-hud-pop-card">',
      '    <div class="agy-hud-pop-card-label">输出 Token 速率</div>',
      '    <div class="agy-hud-pop-card-val agy-val-amber agy-pop-icon-val">' + SVG_BOLT_13 + '<span>' + latestSpeed + ' tok/s</span></div>',
      '    <div class="agy-hud-pop-card-sub">均值 ' + avgSpeed + ' tok/s · 本步 ' + latestDur + 's</div>',
      '  </div>',
      '  <div class="agy-hud-pop-card">',
      '    <div class="agy-hud-pop-card-label">累计耗时与总输出</div>',
      '    <div class="agy-hud-pop-card-val">推理 ' + totalModel + 's</div>',
      '    <div class="agy-hud-pop-card-sub">工具 ' + totalTool + 's · 输出 ' + formatK(totalOutTok) + '</div>',
      '  </div>',
      '  <div class="agy-hud-pop-card agy-hud-pop-wide" title="整个会话所有模型调用累计：新增输入 + 缓存读取 + 输出">',
      '    <div>',
      '      <div class="agy-hud-pop-card-label">会话累计消耗 Token' + (data.isEstimated ? ' (估算)' : '') + '</div>',
      '      <div class="agy-hud-pop-card-val agy-val-blue">Σ ' + formatK(totalTok) + '</div>',
      '    </div>',
      '    <div class="agy-hud-pop-card-sub" style="text-align:right;">新增输入 ' + formatK(totalInTok) + ' · 缓存读 ' + formatK(totalCacheTok) + '<br>输出 ' + formatK(totalOutTok) + '</div>',
      '  </div>',
      '</div>',
      '<div class="agy-hud-pop-bar" title="绿色: 缓存命中 | 橙色: 本步新增输入">',
      '  <div class="agy-hud-pop-bar-cache" style="width:' + cW.toFixed(1) + '%"></div>',
      '  <div class="agy-hud-pop-bar-new" style="width:' + nW.toFixed(1) + '%"></div>',
      '</div>',
      '<div class="agy-hud-pop-section-title">',
      '  <span class="agy-pop-icon-label">' + SVG_FLAME_13 + '<span>吃上下文最多的步骤 (Top 5)</span></span>',
      '  <span>单步新增 Token</span>',
      '</div>'
    ].join('');

    if (!convChanged &&
        slots.upperSlot.__agyHtml === upperHtml &&
        slots.listSlot.__agyHtml === nextListHtml &&
        slots.listSlot.childNodes.length > 0) {
      return;
    }

    if (!isUserAction && !convChanged && (bottomPopPointerDown || Date.now() < bottomPopScrollLockUntil)) {
      scheduleDeferredBottomPopoverRender();
      return;
    }

    var restoreSaved = Boolean(options && options.restoreSavedScroll);
    var prevListScroll = convChanged ? 0 : (restoreSaved ? savedBottomListScrollTop : slots.listSlot.scrollTop);
    var prevPopScroll = convChanged ? 0 : (restoreSaved ? savedBottomPopScrollTop : pop.scrollTop);

    setDisplay(slots.listSlot, '');
    setHtmlIfChanged(slots.upperSlot, upperHtml);
    setHtmlIfChanged(slots.listSlot, nextListHtml);

    if (convChanged) {
      savedBottomListScrollTop = 0;
      savedBottomPopScrollTop = 0;
      if (slots.listSlot.scrollTop !== 0) slots.listSlot.scrollTop = 0;
      if (pop.scrollTop !== 0) pop.scrollTop = 0;
    } else {
      if (slots.listSlot.scrollTop !== prevListScroll) slots.listSlot.scrollTop = prevListScroll;
      if (pop.scrollTop !== prevPopScroll) pop.scrollTop = prevPopScroll;
      savedBottomListScrollTop = slots.listSlot.scrollTop;
      savedBottomPopScrollTop = pop.scrollTop;
    }
    bottomPopLastConvKey = convKey;
  }

  function renderFooterPill(data) {
    var cluster = ensureInputBarMounted();
    if (!cluster) return;

    var arcEl = doc.getElementById('agy-hud-ring-arc');
    var ctxEl = doc.getElementById('agy-hud-ctx-text');
    var sep1 = doc.getElementById('agy-hud-sep-1');
    var cacheEl = doc.getElementById('agy-hud-cache-text');
    var sep2 = doc.getElementById('agy-hud-sep-2');
    var speedEl = doc.getElementById('agy-hud-speed-text');
    var speedValEl = doc.getElementById('agy-hud-speed-val');

    var circumference = 31.42;

    if (!data || activeCascadeId === '__HOME__' || (!Number(data.currentContext || 0) && !Number(data.stepCount || 0) && !Number(data.plannerStepCount || 0) && (!data.steps || data.steps.length === 0))) {
      var idleLim = (data && activeCascadeId !== '__HOME__' && Number(data.contextLimit) > 0)
        ? Number(data.contextLimit)
        : getIdleContextLimit();
      setAttr(arcEl, 'stroke-dashoffset', String(circumference));
      setAttr(arcEl, 'class', 'agy-hud-ring-arc');
      setText(ctxEl, '0 / ' + formatLimitK(idleLim));
      setAttr(ctxEl, 'class', 'agy-hud-ctx-text');
      setDisplay(sep1, 'none');
      setDisplay(cacheEl, 'none');
      setDisplay(sep2, 'none');
      setDisplay(speedEl, 'none');
      if (speedValEl) setText(speedValEl, '--/s');
      if (breakdownOpen) renderPopoverContent(null);
      return;
    }

    var curCtx = Number(data.currentContext || 0);
    var peakCtx = Number(data.peakContext || curCtx);
    var pct = Number(data.contextUsagePct || 0);
    var levelClass = pct >= 85 ? ' danger' : (pct >= 60 ? ' warn' : '');

    if (arcEl) {
      var clampedRatio = Math.max(0.03, Math.min(1, pct / 100));
      var offset = (circumference * (1 - clampedRatio)).toFixed(2);
      setAttr(arcEl, 'stroke-dashoffset', String(offset));
      setAttr(arcEl, 'class', 'agy-hud-ring-arc' + levelClass);
    }

    if (ctxEl) {
      var peakSuffix = peakCtx > curCtx + 10000 ? (' (峰' + formatK(peakCtx) + ')') : (' (' + pct + '%)');
      setText(ctxEl, formatK(curCtx) + peakSuffix);
      setAttr(ctxEl, 'class', 'agy-hud-ctx-text' + levelClass);
    }

    setDisplay(sep1, '');
    if (cacheEl) {
      setDisplay(cacheEl, '');
      setText(cacheEl, '缓 ' + Math.round(Number(data.latestCacheHitRate || 0)) + '%');
    }

    setDisplay(sep2, '');
    if (speedEl) {
      setDisplay(speedEl, '');
      if (speedValEl) setText(speedValEl, Number(data.latestTokPerSec || 0) + '/s');
    }

    if (breakdownOpen) {
      renderPopoverContent(data);
      positionPopover();
    }
  }

  function applyTelemetryUpdate(data) {
    if (!data || data.error) return;
    noteBackendPatchFromData(data);
    if (data.dailyUsage) {
      updateDailyUsage(data.dailyUsage, data);
    } else if (!currentDailyUsage && (Number(data.totalTokens || 0) > 0 || Number(data.totalInputTokens || 0) > 0 || Number(data.totalCacheReadTokens || 0) > 0 || Number(data.totalOutputTokens || 0) > 0)) {
      updateDailyUsage(null, data);
    } else {
      renderTopBar(currentDailyUsage);
    }
    if (data.conversationId) {
      setTelemetryCache(data.conversationId, data);
    }
    var detected = detectActiveCascadeId();
    if (detected === '__HOME__') {
      // Never overwrite the New Conversation screen with a previous conversation's snapshot
      currentTelemetry = null;
      renderFooterPill(null);
      return;
    }
    if (detected && data.conversationId && data.conversationId !== detected) {
      // Do not overwrite the active conversation's display with another conversation's snapshot
      return;
    }
    currentTelemetry = data;
    renderFooterPill(data);
  }

  function fetchTelemetryForConversation(convId, options) {
    var skipImmediateRender = Boolean(options && options.skipImmediateRender);
    if (!convId || convId === '__HOME__') {
      ensureHomeInitFetched();
      if (!skipImmediateRender || currentTelemetry !== null) {
        currentTelemetry = null;
        renderFooterPill(null);
      }
      renderTopBar(currentDailyUsage);
      return;
    }

    var cached = getTelemetryCache(convId);
    if (!skipImmediateRender || currentTelemetry !== cached) {
      // Immediately show cached snapshot for this conversation, or reset to 0 / <limit> while loading
      currentTelemetry = cached;
      if (currentTelemetry && currentTelemetry.dailyUsage && !currentDailyUsage) {
        updateDailyUsage(currentTelemetry.dailyUsage, currentTelemetry);
      }
      renderFooterPill(currentTelemetry);
    }

    // Electron IPC handler injected into the main process by fast-patch.cjs.
    // (The former HTTP bridge fallback on 127.0.0.1:53991 was removed for security.)
    if (typeof root.__AGY_HUD_FETCH__ === 'function') {
      if (fetchingConvId === convId) return;
      fetchingConvId = convId;
      Promise.resolve(root.__AGY_HUD_FETCH__(convId))
        .then(function (data) {
          if (fetchingConvId === convId) fetchingConvId = null;
          if (destroyed) return;
          if (data && !data.error) {
            noteBackendPatchFromData(data);
            if (data.dailyUsage) {
              updateDailyUsage(data.dailyUsage, data);
            }
          }
          var hasTelemetrySignal = Boolean(
            data && !data.error && (
              Number(data.currentContext || 0) > 0 ||
              Number(data.stepCount || 0) > 0 ||
              Number(data.plannerStepCount || 0) > 0 ||
              Number(data.totalTokens || 0) > 0
            )
          );
          if (hasTelemetrySignal) {
            applyTelemetryUpdate(data);
          } else if (activeCascadeId === convId) {
            currentTelemetry = null;
            renderFooterPill(data || null);
          }
        })
        .catch(function () {
          if (fetchingConvId === convId) fetchingConvId = null;
        });
    }
  }

  function syncDomAndConversation(options) {
    var fromPoll = Boolean(options && options.fromPoll);
    var prevCluster = doc.getElementById('agy-hud-footer-cluster');
    ensureTopBarMounted();
    var nextCluster = ensureInputBarMounted();
    var clusterNewlyMounted = Boolean(nextCluster && nextCluster !== prevCluster);
    ensureHomeInitFetched();
    if (!fromPoll) {
      renderTopBar(currentDailyUsage);
    }
    var detected = detectActiveCascadeId();
    var cascadeChanged = detected !== activeCascadeId;
    if (cascadeChanged) {
      activeCascadeId = detected;
      if (!activeCascadeId || activeCascadeId === '__HOME__') {
        currentTelemetry = null;
        renderFooterPill(null);
      } else {
        fetchTelemetryForConversation(activeCascadeId);
      }
    } else if (activeCascadeId === '__HOME__') {
      if (currentTelemetry !== null || clusterNewlyMounted || !fromPoll) {
        currentTelemetry = null;
        renderFooterPill(null);
      }
    } else if (activeCascadeId && (!fromPoll || clusterNewlyMounted)) {
      renderFooterPill(currentTelemetry);
    }
    return cascadeChanged;
  }

  function addTrackedListener(target, type, fn, capture) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, fn, capture);
    cleanupFns.push(function () {
      if (typeof target.removeEventListener === 'function') {
        target.removeEventListener(type, fn, capture);
      }
    });
  }

  function setupGlobalListeners() {
    addTrackedListener(doc, 'agy-hud-close-popovers', function () {
      if (breakdownOpen) setPopoverOpen(false);
      if (topPopoverOpen) setTopPopoverOpen(false);
    });

    addTrackedListener(doc, 'click', function (ev) {
      var t = ev.target;
      if (breakdownOpen) {
        var pop = doc.getElementById('agy-hud-popover');
        var cluster = doc.getElementById('agy-hud-footer-cluster');
        if ((!pop || !pop.contains(t)) && (!cluster || !cluster.contains(t))) {
          setPopoverOpen(false);
        }
      }
      if (topPopoverOpen) {
        var topPop = doc.getElementById('agy-hud-top-popover');
        var topBar = doc.getElementById('agy-hud-topbar');
        if ((!topPop || !topPop.contains(t)) && (!topBar || !topBar.contains(t))) {
          setTopPopoverOpen(false);
        }
      }
    }, true);

    addTrackedListener(doc, 'keydown', function (ev) {
      if (ev.key === 'Escape' && (breakdownOpen || topPopoverOpen)) {
        var wasBottom = breakdownOpen;
        var wasTop = topPopoverOpen;
        ev.stopPropagation();
        if (wasBottom) setPopoverOpen(false);
        if (wasTop) setTopPopoverOpen(false);
        var focusTarget = wasBottom
          ? doc.getElementById('agy-hud-toggle-btn')
          : (doc.getElementById('agy-hud-topbar-btn') || doc.getElementById('agy-hud-top-trigger'));
        if (focusTarget && typeof focusTarget.focus === 'function') {
          try { focusTarget.focus(); } catch (_) {}
        }
      }
    });

    addTrackedListener(root, 'storage', function (ev) {
      if (!ev || ev.key !== THEME_STORAGE_KEY) return;
      if (ev.newValue === 'dark' || ev.newValue === 'light') {
        applyHudTheme(ev.newValue, false);
      }
    });

    var releasePopPointer = function () {
      topPopPointerDown = false;
      bottomPopPointerDown = false;
    };
    addTrackedListener(doc, 'mouseup', releasePopPointer);
    if (typeof root.PointerEvent !== 'undefined') {
      addTrackedListener(doc, 'pointerup', releasePopPointer);
      addTrackedListener(doc, 'pointercancel', releasePopPointer);
    }
    addTrackedListener(root, 'blur', releasePopPointer);
    addTrackedListener(root, 'resize', function () {
      if (breakdownOpen) positionPopover();
      if (topPopoverOpen) positionTopPopover();
    });
    addTrackedListener(root, 'pagehide', destroy);

    if (typeof root.MutationObserver === 'function' && doc.body) {
      // Streaming chat output produces a flood of DOM mutations; coalesce them so the
      // (query-heavy) sync runs at most once per SYNC_THROTTLE_MS.
      var SYNC_THROTTLE_MS = 200;
      var syncScheduled = false;
      var scheduleSync = function () {
        if (syncScheduled || destroyed) return;
        syncScheduled = true;
        setTimeout(function () {
          syncScheduled = false;
          if (destroyed) return;
          try { syncDomAndConversation(); } catch (_) {}
        }, SYNC_THROTTLE_MS);
      };
      mutationObserver = new root.MutationObserver(function (mutations) {
        if (syncScheduled) return;
        for (var i = 0; i < mutations.length; i++) {
          var t = mutations[i].target;
          if (t && typeof t.closest === 'function' && (t.closest('#agy-hud-footer-cluster') || t.closest('#agy-hud-popover') || t.closest('#agy-hud-topbar') || t.closest('#agy-hud-top-popover'))) {
            continue;
          }
          scheduleSync();
          break;
        }
      });
      mutationObserver.observe(doc.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-cascade-id']
      });
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    breakdownOpen = false;
    topPopoverOpen = false;
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (topPopDeferredTimer !== null) {
      clearTimeout(topPopDeferredTimer);
      topPopDeferredTimer = null;
    }
    if (bottomPopDeferredTimer !== null) {
      clearTimeout(bottomPopDeferredTimer);
      bottomPopDeferredTimer = null;
    }
    if (mutationObserver) {
      try { mutationObserver.disconnect(); } catch (_) {}
      mutationObserver = null;
    }
    while (cleanupFns.length > 0) {
      var fn = cleanupFns.pop();
      try { fn(); } catch (_) {}
    }
    var ids = [
      'agy-hud-topbar',
      'agy-hud-top-popover',
      'agy-hud-popover',
      'agy-hud-footer-cluster',
      'agy-hud-styles'
    ];
    for (var i = 0; i < ids.length; i++) {
      var el = doc.getElementById(ids[i]);
      if (el && el.parentElement) {
        try { el.parentElement.removeChild(el); } catch (_) {}
      }
    }
    root.__AGY_HUD_INITIALIZED__ = false;
  }

  function startEngine() {
    if (destroyed) return;
    setupGlobalListeners();
    syncDomAndConversation();

    if (currentTelemetry && !activeCascadeId) {
      renderFooterPill(currentTelemetry);
    }

    // Periodic Electron IPC sync timer (set __AGY_HUD_DISABLE_POLL__ = true in unit tests to drive sync() manually).
    if (!root.__AGY_HUD_DISABLE_POLL__ && pollTimer === null) {
      pollTimer = setInterval(function () {
        if (doc.hidden || destroyed) return; // don't poll for windows that are minimized / in background
        var cascadeChanged = syncDomAndConversation({ fromPoll: true });
        if (cascadeChanged) return;
        if (activeCascadeId && activeCascadeId !== '__HOME__') {
          fetchTelemetryForConversation(activeCascadeId, { skipImmediateRender: true });
        } else {
          fetchHomeTelemetry();
        }
      }, 1500);
      if (pollTimer && typeof pollTimer.unref === 'function') pollTimer.unref();
    }
  }

  root.__AGY_HUD__ = {
    update: applyTelemetryUpdate,
    updateDaily: updateDailyUsage,
    ensureInputBarMounted: ensureInputBarMounted,
    ensureTopBarMounted: ensureTopBarMounted,
    sync: syncDomAndConversation,
    setPopoverOpen: setPopoverOpen,
    setTopPopoverOpen: setTopPopoverOpen,
    selectDailyDate: selectDailyDate,
    selectDailyScope: selectDailyScope,
    selectWeekOffset: selectWeekOffset,
    navigateWeekOffset: navigateWeekOffset,
    setTheme: setHudTheme,
    toggleTheme: toggleHudTheme,
    destroy: destroy,
    getTheme: function () { return hudTheme; },
    getState: function () { return currentTelemetry; },
    getDailyState: function () { return currentDailyUsage; },
    getSelectedDate: function () { return selectedDailyDate; },
    getSelectedScope: function () { return selectedDailyScope; },
    getSelectedWeekOffset: function () { return selectedWeekOffset; },
    getActiveCascadeId: function () { return activeCascadeId; }
  };

  if (!doc.body && doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', startEngine);
  } else {
    startEngine();
  }
})(typeof window !== 'undefined' ? window : this);
