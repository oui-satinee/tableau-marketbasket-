(function () {
  "use strict";

  // ─── State ───────────────────────────────────────────────
  let ALL_RECORDS = [];
  let selectedWorksheet = null;
  let unregisterFilterFns = [];

  const COLORS = {
    within: "#8a4b2a",
    cross: "#1b6f73",
    grid: "#e8ddd0",
    text: "#24323d"
  };

  // ─── Column mapping: internal field → possible worksheet column names ───
  const COLUMN_MAP = {
    analysis_type: ["analysis_type", "analysis type", "analysis_type_label", "analysis type label"],
    category_antecedent: ["category_antecedent", "category antecedent", "antecedent category"],
    category_consequent: ["category_consequent", "category consequent", "consequent category"],
    antecedent_name: ["antecedent_name", "antecedent name", "antecedent"],
    consequent_name: ["consequent_name", "consequent name", "consequent"],
    pair_count: ["pair_count", "pair count"],
    support: ["support"],
    confidence: ["confidence"],
    lift: ["lift"],
    leverage: ["leverage"],
    conviction: ["conviction"],
    itemset_size: ["itemset_size", "itemset size", "itemset"],
    opportunity_score: ["opportunity_score", "opportunity score"],
    rule_label: ["rule_label", "rule label", "rule"],
    volume_score: ["volume_score", "volume score"],
    support_score: ["support_score", "support score"],
    lift_score: ["lift_score", "lift score"],
    confidence_score: ["confidence_score", "confidence score"]
  };

  // ─── Utility functions ──────────────────────────────────
  function formatNumber(value, digits) {
    if (value === null || value === undefined) return "-";
    if (typeof value !== "number") return value;
    return value.toLocaleString("en-US", {
      minimumFractionDigits: digits !== undefined ? digits : 0,
      maximumFractionDigits: digits !== undefined ? digits : 2
    });
  }

  function formatPercent(value, digits) {
    if (value === null || value === undefined) return "-";
    return (value * 100).toFixed(digits !== undefined ? digits : 1) + "%";
  }

  function optionHtml(value, label) {
    return '<option value="' + value + '">' + label + "</option>";
  }

  function parseNumber(val) {
    if (val === null || val === undefined || val === "") return 0;
    var n = Number(val);
    return isNaN(n) ? 0 : n;
  }

  // ─── Column auto-detect ────────────────────────────────
  function normalize(name) {
    return name.toLowerCase().trim().replace(/[_\s-]+/g, "");
  }

  function stripAggregation(name) {
    // Remove Tableau aggregation prefixes: SUM(...), AVG(...), CNT(...), etc.
    return name.replace(/^(sum|avg|cnt|count|min|max|attr|median|stdev|var)\s*\(\s*/i, "").replace(/\s*\)$/, "");
  }

  function buildColumnIndex(columns) {
    var index = {};
    columns.forEach(function (col, i) {
      var name = col.fieldName.toLowerCase().trim();
      var strippedName = stripAggregation(name).toLowerCase().trim();
      var nameNorm = normalize(name);
      var strippedNorm = normalize(strippedName);
      Object.keys(COLUMN_MAP).forEach(function (field) {
        if (index[field]) return;
        var aliases = COLUMN_MAP[field].map(function (a) { return a.toLowerCase(); });
        // exact match first
        if (aliases.indexOf(name) !== -1) {
          index[field] = i;
          return;
        }
        // normalized match (strip all underscores, spaces, dashes)
        if (aliases.some(function (a) { return normalize(a) === nameNorm; })) {
          index[field] = i;
          return;
        }
        // match after stripping aggregation: SUM(Pair Count) → pair count
        if (aliases.indexOf(strippedName) !== -1) {
          index[field] = i;
          return;
        }
        if (aliases.some(function (a) { return normalize(a) === strippedNorm; })) {
          index[field] = i;
        }
      });
    });
    return index;
  }

  // ─── Data extraction from Tableau ──────────────────────
  function extractRecords(dataTable) {
    var columns = dataTable.columns;
    var rows = dataTable.data;
    var colIndex = buildColumnIndex(columns);

    return rows.map(function (row, i) {
      function val(field) {
        var idx = colIndex[field];
        if (idx === undefined) return null;
        var cell = row[idx];
        return cell ? (cell.value !== undefined ? cell.value : cell.formattedValue) : null;
      }

      var analysisType = val("analysis_type") || "within_category";
      var antecedent = val("antecedent_name") || "";
      var consequent = val("consequent_name") || "";
      var itemsetSize = parseNumber(val("itemset_size")) || 2;

      return {
        row_id: i + 1,
        analysis_type: analysisType,
        analysis_type_label: analysisType === "cross_category" ? "Cross Category" : "Within Category",
        category_antecedent: val("category_antecedent") || "",
        category_consequent: val("category_consequent") || "",
        antecedent_name: antecedent,
        consequent_name: consequent,
        pair_count: parseNumber(val("pair_count")),
        support: parseNumber(val("support")),
        confidence: parseNumber(val("confidence")),
        lift: parseNumber(val("lift")),
        leverage: parseNumber(val("leverage")),
        conviction: val("conviction") !== null ? parseNumber(val("conviction")) : null,
        itemset_size: itemsetSize,
        volume_score: parseNumber(val("volume_score")),
        support_score: parseNumber(val("support_score")),
        lift_score: parseNumber(val("lift_score")),
        confidence_score: parseNumber(val("confidence_score")),
        opportunity_score: parseNumber(val("opportunity_score")),
        rule_label: val("rule_label") || (antecedent + " → " + consequent),
        search_blob: (antecedent + " " + consequent).toLowerCase()
      };
    });
  }

  // ─── Load data from Tableau worksheet ──────────────────
  function loadWorksheetData(worksheet) {
    showLoading(true, "Reading data from " + worksheet.name + "...");

    // Try getSummaryDataAsync first (simpler, more compatible)
    var dataPromise;
    if (typeof worksheet.getSummaryDataAsync === "function") {
      dataPromise = worksheet.getSummaryDataAsync().then(function (dataTable) {
        var columns = dataTable.columns || [];
        var rows = dataTable.data || [];
        return { columns: columns, data: rows };
      });
    } else {
      // Fallback to DataReader API
      dataPromise = worksheet.getSummaryDataReaderAsync(10000).then(function (dataReader) {
        var allRows = [];
        var columns = [];
        var totalPages = dataReader.totalPageCount || 1;

        function readPage(idx) {
          return dataReader.getPageAsync(idx).then(function (page) {
            if (page.columns && page.columns.length > 0) {
              columns = page.columns;
            }
            if (page.data) {
              allRows = allRows.concat(page.data);
            }
            if (idx + 1 < totalPages) {
              return readPage(idx + 1);
            }
            return { columns: columns, data: allRows };
          });
        }
        return readPage(0).then(function (result) {
          dataReader.releaseAsync();
          return result;
        });
      });
    }

    return dataPromise.then(function (dataTable) {
      ALL_RECORDS = extractRecords(dataTable);

      if (ALL_RECORDS.length === 0) {
        showError("No data found in worksheet. Please check that the worksheet contains market basket rule data with the expected columns.");
        showLoading(false);
        return;
      }

      showLoading(false);
      showDashboard(true);
      init();
    }).catch(function (err) {
      showLoading(false);
      showError("Error reading data: " + err.message);
      console.error("Data load error:", err);
    });
  }

  // ─── UI helpers ────────────────────────────────────────
  function showLoading(show, message) {
    var overlay = document.getElementById("loadingOverlay");
    if (show) {
      if (message) {
        document.getElementById("loadingMessage").textContent = message;
      }
      overlay.classList.add("active");
    } else {
      overlay.classList.remove("active");
    }
  }

  function showError(message) {
    var banner = document.getElementById("errorBanner");
    banner.textContent = message;
    banner.classList.add("active");
  }

  function hideError() {
    document.getElementById("errorBanner").classList.remove("active");
  }

  function showDashboard(show) {
    var ids = [
      "dashboardContent", "filterSection", "visualAnalysisSection",
      "ruleDetailSection", "insightSection", "howToReadMetricsSection", "shortlistSection"
    ];
    ids.forEach(function (id) {
      document.getElementById(id).style.display = show ? "" : "none";
    });
  }

  // ─── Filter pipeline ──────────────────────────────────
  function populateFilters() {
    var analysisTypes = new Set();
    var itemsetSizes = new Set();
    var antCategories = new Set();
    var conCategories = new Set();

    ALL_RECORDS.forEach(function (r) {
      if (r.analysis_type) analysisTypes.add(r.analysis_type);
      if (r.itemset_size) itemsetSizes.add(r.itemset_size);
      if (r.category_antecedent) antCategories.add(r.category_antecedent);
      if (r.category_consequent) conCategories.add(r.category_consequent);
    });

    var atSel = document.getElementById("analysisType");
    atSel.innerHTML = optionHtml("all", "All Types");
    ["within_category", "cross_category"].forEach(function (t) {
      if (analysisTypes.has(t)) {
        var label = t === "cross_category" ? "Cross Category" : "Within Category";
        atSel.innerHTML += optionHtml(t, label);
      }
    });

    var isSel = document.getElementById("itemsetSize");
    isSel.innerHTML = optionHtml("all", "All Sizes");
    [2, 3].forEach(function (s) {
      if (itemsetSizes.has(s)) {
        isSel.innerHTML += optionHtml(s, s + " items");
      }
    });

    var acSel = document.getElementById("antecedentCategory");
    acSel.innerHTML = optionHtml("all", "All Categories");
    [...antCategories].sort().forEach(function (c) {
      acSel.innerHTML += optionHtml(c, c);
    });

    var ccSel = document.getElementById("consequentCategory");
    ccSel.innerHTML = optionHtml("all", "All Categories");
    [...conCategories].sort().forEach(function (c) {
      ccSel.innerHTML += optionHtml(c, c);
    });
  }

  function getFilterState() {
    return {
      analysisType: document.getElementById("analysisType").value,
      itemsetSize: document.getElementById("itemsetSize").value,
      antecedentCategory: document.getElementById("antecedentCategory").value,
      consequentCategory: document.getElementById("consequentCategory").value,
      sortBy: document.getElementById("sortBy").value
    };
  }

  function filterRecords(records, filters) {
    return records.filter(function (r) {
      if (filters.analysisType !== "all" && r.analysis_type !== filters.analysisType) return false;
      if (filters.itemsetSize !== "all" && r.itemset_size !== Number(filters.itemsetSize)) return false;
      if (filters.antecedentCategory !== "all" && r.category_antecedent !== filters.antecedentCategory) return false;
      if (filters.consequentCategory !== "all" && r.category_consequent !== filters.consequentCategory) return false;
      return true;
    });
  }

  function sortRecords(records, sortBy) {
    var sorted = records.slice();
    var sorters = {
      opportunity_score_desc: function (a, b) { return b.opportunity_score - a.opportunity_score || b.pair_count - a.pair_count; },
      pair_count_desc: function (a, b) { return b.pair_count - a.pair_count || b.confidence - a.confidence; },
      confidence_desc: function (a, b) { return b.confidence - a.confidence || b.pair_count - a.pair_count; },
      lift_desc: function (a, b) { return b.lift - a.lift || b.pair_count - a.pair_count; },
      support_desc: function (a, b) { return b.support - a.support || b.pair_count - a.pair_count; }
    };
    return sorted.sort(sorters[sortBy] || sorters.opportunity_score_desc);
  }

  // ─── Summarize ────────────────────────────────────────
  function summarize(records) {
    var totalRules = records.length;
    var withinRules = 0;
    var crossRules = 0;
    var pairRules = 0;
    var tripletRules = 0;
    var totalPairCount = 0;
    var liftSum = 0;
    var confSum = 0;
    var maxLift = 0;
    var products = new Set();

    records.forEach(function (r) {
      if (r.analysis_type === "cross_category") crossRules++;
      else withinRules++;
      if (r.itemset_size === 3) tripletRules++;
      else pairRules++;
      totalPairCount += r.pair_count;
      liftSum += r.lift;
      confSum += r.confidence;
      if (r.lift > maxLift) maxLift = r.lift;
      products.add(r.antecedent_name);
      products.add(r.consequent_name);
    });

    return {
      totalRules: totalRules,
      withinRules: withinRules,
      crossRules: crossRules,
      pairRules: pairRules,
      tripletRules: tripletRules,
      totalPairCount: totalPairCount,
      avgLift: totalRules > 0 ? liftSum / totalRules : 0,
      avgConfidence: totalRules > 0 ? confSum / totalRules : 0,
      maxLift: maxLift,
      uniqueProducts: products.size,
      avgOpportunity: totalRules > 0
        ? records.reduce(function (s, r) { return s + r.opportunity_score; }, 0) / totalRules
        : 0
    };
  }

  function topCategory(records) {
    var catMap = {};
    records.forEach(function (r) {
      if (!catMap[r.category_antecedent]) catMap[r.category_antecedent] = { pairs: 0, rules: 0 };
      catMap[r.category_antecedent].pairs += r.pair_count;
      catMap[r.category_antecedent].rules += 1;
    });
    var top = { name: "-", pairs: 0 };
    Object.keys(catMap).forEach(function (k) {
      if (catMap[k].pairs > top.pairs) top = { name: k, pairs: catMap[k].pairs, rules: catMap[k].rules };
    });
    return top;
  }

  function topCrossFlow(records) {
    var flowMap = {};
    records.filter(function (r) { return r.analysis_type === "cross_category"; }).forEach(function (r) {
      var key = r.category_antecedent + " → " + r.category_consequent;
      if (!flowMap[key]) flowMap[key] = { pairCount: 0, rules: 0 };
      flowMap[key].pairCount += r.pair_count;
      flowMap[key].rules += 1;
    });
    var top = { flow: "-", pairCount: 0 };
    Object.keys(flowMap).forEach(function (k) {
      if (flowMap[k].pairCount > top.pairCount) top = { flow: k, pairCount: flowMap[k].pairCount, rules: flowMap[k].rules };
    });
    return top;
  }

  function bestRule(records, predicate) {
    var filtered = predicate ? records.filter(predicate) : records;
    if (filtered.length === 0) return null;
    return filtered.slice().sort(function (a, b) {
      return b.confidence - a.confidence || b.pair_count - a.pair_count || b.lift - a.lift;
    })[0];
  }

  // ─── Render functions ──────────────────────────────────
  function renderKpis(records) {
    var s = summarize(records);
    var topCat = topCategory(records);
    var topRule = bestRule(records);
    document.getElementById("kpi-grid").innerHTML = [
      { label: "Filtered Rules", value: formatNumber(s.totalRules), sub: "Within: " + formatNumber(s.withinRules) + " | Cross: " + formatNumber(s.crossRules), sm: false },
      { label: "Total Pair Count", value: formatNumber(s.totalPairCount), sub: "Pairs: " + formatNumber(s.pairRules) + " | Triplets: " + formatNumber(s.tripletRules), sm: false },
      { label: "Average Opportunity", value: formatNumber(s.avgOpportunity, 1), sub: "Composite score (0-100)", sm: false },
      { label: "Average Lift", value: formatNumber(s.avgLift, 2), sub: "Max lift: " + formatNumber(s.maxLift, 2), sm: false },
      { label: "Top Opportunity Rule", value: topRule ? (topRule.antecedent_name.substring(0, 40) + " → " + topRule.consequent_name.substring(0, 30)) : "-", sub: topRule ? "Opp: " + formatNumber(topRule.opportunity_score, 1) + " | Conf: " + formatPercent(topRule.confidence, 1) : "", sm: true },
      { label: "Average Confidence", value: formatPercent(s.avgConfidence, 1), sub: "Across " + formatNumber(s.totalRules) + " rules", sm: false },
      { label: "Top Category", value: topCat.name.substring(0, 35), sub: formatNumber(topCat.pairs) + " pairs | " + formatNumber(topCat.rules) + " rules", sm: true },
      { label: "Unique Products", value: formatNumber(s.uniqueProducts), sub: "Distinct items in rules", sm: false }
    ].map(function (kpi) {
      return '<div class="kpi-card"><div class="kpi-label">' + kpi.label + '</div><div class="kpi-value' + (kpi.sm ? " sm" : "") + '">' + kpi.value + '</div><div class="kpi-sub">' + kpi.sub + "</div></div>";
    }).join("");
  }

  function renderInsights(records) {
    var insights = [];

    var volDriver = topCategory(records);
    if (volDriver.name !== "-") {
      insights.push({
        chip: "VOLUME DRIVER",
        title: volDriver.name,
        body: "หมวด \"" + volDriver.name + "\" มี pair count สูงสุดที่ " + formatNumber(volDriver.pairs) + " คู่ (" + formatNumber(volDriver.rules) + " กฎ) ควรเป็นจุดเริ่มต้นของ cross-sell campaign"
      });
    }

    var flow = topCrossFlow(records);
    if (flow.flow !== "-") {
      insights.push({
        chip: "CROSS-SELL PATH",
        title: flow.flow,
        body: "Flow ข้ามหมวดที่แรงที่สุด มี " + formatNumber(flow.pairCount) + " คู่ใน " + formatNumber(flow.rules) + " กฎ ซึ่งหมายถึงโอกาส cross-sell ที่ชัดเจน"
      });
    }

    var hcRule = bestRule(records, function (r) { return r.pair_count >= 100; });
    if (hcRule) {
      insights.push({
        chip: "HIGH CONFIDENCE",
        title: hcRule.rule_label.substring(0, 60),
        body: "Confidence " + formatPercent(hcRule.confidence, 1) + " กับ volume " + formatNumber(hcRule.pair_count) + " คู่ เหมาะทำ recommendation หรือใส่ใน bundle"
      });
    }

    var tripRule = bestRule(records, function (r) { return r.itemset_size === 3 && r.pair_count >= 50; });
    if (tripRule) {
      insights.push({
        chip: "TRIPLET BUNDLE",
        title: tripRule.rule_label.substring(0, 60),
        body: "กฎ 3 สินค้าที่ confidence " + formatPercent(tripRule.confidence, 1) + " และ lift " + formatNumber(tripRule.lift, 2) + " เหมาะทำ bundle deal"
      });
    }

    if (insights.length === 0) {
      insights.push({ chip: "NO DATA", title: "ไม่พบข้อมูล", body: "ลองปรับ filter หรือตรวจสอบว่า worksheet มีข้อมูลตรงตาม column ที่ต้องการ" });
    }

    document.getElementById("insight-grid").innerHTML = insights.map(function (item) {
      return '<div class="insight-card">' +
        '<div class="insight-chip">' + item.chip + '</div>' +
        '<div class="insight-title">' + item.title + '</div>' +
        '<div class="insight-body">' + item.body + '</div>' +
        '</div>';
    }).join("");
  }

  function aggregateTopCategories(records) {
    var catMap = {};
    records.forEach(function (r) {
      if (!catMap[r.category_antecedent]) catMap[r.category_antecedent] = { totalPairs: 0, rules: 0, confSum: 0 };
      catMap[r.category_antecedent].totalPairs += r.pair_count;
      catMap[r.category_antecedent].rules += 1;
      catMap[r.category_antecedent].confSum += r.confidence;
    });
    return Object.keys(catMap).map(function (name) {
      var v = catMap[name];
      return { name: name, totalPairs: v.totalPairs, rules: v.rules, avgConfidence: v.confSum / v.rules };
    }).sort(function (a, b) { return b.totalPairs - a.totalPairs; }).slice(0, 10);
  }

  function aggregateCrossFlows(records) {
    var crossMap = {};
    records.filter(function (r) { return r.analysis_type === "cross_category"; }).forEach(function (r) {
      var key = r.category_antecedent + "|||" + r.category_consequent;
      if (!crossMap[key]) crossMap[key] = { pairCount: 0, rules: 0 };
      crossMap[key].pairCount += r.pair_count;
      crossMap[key].rules += 1;
    });
    return Object.keys(crossMap).map(function (key) {
      var parts = key.split("|||");
      var v = crossMap[key];
      return { flow: parts[0] + " → " + parts[1], pairCount: v.pairCount, rules: v.rules };
    }).sort(function (a, b) { return b.pairCount - a.pairCount; }).slice(0, 10);
  }

  function renderCharts(records) {
    var plotConfig = {
      displayModeBar: false,
      responsive: true
    };

    // --- Top Categories bar chart ---
    var topCategories = aggregateTopCategories(records);
    var maxX1 = topCategories.reduce(function (m, i) { return Math.max(m, i.totalPairs); }, 0);
    Plotly.newPlot("topCategoryChart", [{
      x: topCategories.map(function (i) { return i.totalPairs; }),
      y: topCategories.map(function (i) { return i.name; }),
      type: "bar",
      orientation: "h",
      marker: { color: COLORS.within },
      text: topCategories.map(function (i) { return formatNumber(i.totalPairs); }),
      textposition: "outside",
      textfont: { size: 10 },
      cliponaxis: false,
      customdata: topCategories.map(function (i) { return [i.name, i.rules, i.avgConfidence]; }),
      hovertemplate: "%{customdata[0]}<br>Pair Count: %{x:,}<br>Rules: %{customdata[1]}<br>Avg Confidence: %{customdata[2]:.1%}<extra></extra>"
    }], {
      title: { text: "Top Antecedent Categories", font: { size: 13 } },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      margin: { t: 36, r: 80, b: 24, l: 120 },
      bargap: 0.35,
      height: 300,
      autosize: true,
      yaxis: { autorange: "reversed", tickfont: { size: 10 } },
      xaxis: { gridcolor: COLORS.grid, showticklabels: false, showgrid: true, range: [0, maxX1 * 1.35] },
      font: { color: COLORS.text, size: 10 }
    }, plotConfig);

    // --- Cross Flows bar chart ---
    var crossFlows = aggregateCrossFlows(records);
    var maxX2 = crossFlows.reduce(function (m, i) { return Math.max(m, i.pairCount); }, 0);
    Plotly.newPlot("crossFlowChart", [{
      x: crossFlows.map(function (i) { return i.pairCount; }),
      y: crossFlows.map(function (i) { return i.flow; }),
      type: "bar",
      orientation: "h",
      marker: { color: COLORS.cross },
      text: crossFlows.map(function (i) { return formatNumber(i.pairCount); }),
      textposition: "outside",
      textfont: { size: 10 },
      cliponaxis: false,
      customdata: crossFlows.map(function (i) { return [i.flow, i.rules]; }),
      hovertemplate: "%{customdata[0]}<br>Pair Count: %{x:,}<br>Rules: %{customdata[1]}<extra></extra>"
    }], {
      title: { text: "Top Cross-Category Flows", font: { size: 13 } },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      margin: { t: 36, r: 80, b: 24, l: 150 },
      bargap: 0.35,
      height: 300,
      autosize: true,
      yaxis: { autorange: "reversed", tickfont: { size: 10 } },
      xaxis: { gridcolor: COLORS.grid, showticklabels: false, showgrid: true, range: [0, maxX2 * 1.35] },
      font: { color: COLORS.text, size: 10 }
    }, plotConfig);

    // --- Scatter plot ---
    Plotly.newPlot("scatterChart", [{
      x: records.map(function (i) { return i.confidence; }),
      y: records.map(function (i) { return i.lift; }),
      mode: "markers",
      type: "scatter",
      marker: {
        size: records.map(function (i) { return Math.max(6, Math.min(20, i.pair_count / 250)); }),
        color: records.map(function (i) { return i.analysis_type === "cross_category" ? COLORS.cross : COLORS.within; }),
        opacity: 0.7,
        line: { width: 1, color: "#ffffff" }
      },
      text: records.map(function (i) { return i.rule_label; }),
      customdata: records.map(function (i) { return [i.pair_count, i.itemset_size, i.analysis_type_label]; }),
      hovertemplate: "%{text}<br>Confidence: %{x:.1%}<br>Lift: %{y:.2f}<br>Pair Count: %{customdata[0]:,}<br>Itemset: %{customdata[1]}<br>Type: %{customdata[2]}<extra></extra>"
    }], {
      title: { text: "Confidence vs Lift (bubble = pair count)", font: { size: 13 } },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      margin: { t: 36, r: 20, b: 50, l: 55 },
      height: 320,
      autosize: true,
      xaxis: { title: "Confidence", tickformat: ".0%", gridcolor: COLORS.grid },
      yaxis: { title: "Lift", gridcolor: COLORS.grid },
      font: { color: COLORS.text, size: 11 }
    }, plotConfig);

    // Force Plotly to recalculate sizes after DOM settles
    setTimeout(function () {
      Plotly.Plots.resize("topCategoryChart");
      Plotly.Plots.resize("crossFlowChart");
      Plotly.Plots.resize("scatterChart");
    }, 300);
  }

  function renderShortlists(records) {
    var topLift = records.slice().sort(function (a, b) {
      return b.lift - a.lift || b.confidence - a.confidence || b.pair_count - a.pair_count;
    }).slice(0, 8);

    var topVolume = records.slice().sort(function (a, b) {
      return b.opportunity_score - a.opportunity_score || b.pair_count - a.pair_count || b.confidence - a.confidence;
    }).slice(0, 8);

    function listHtml(items, metricLabel) {
      return '<ol class="helper-list">' + items.map(function (item) {
        return '<li><strong>' + item.rule_label + '</strong><br>' +
          metricLabel + ": " + (metricLabel === "Lift" ? formatNumber(item.lift, 2) : formatNumber(item.opportunity_score, 1)) +
          " | Opp Score: " + formatNumber(item.opportunity_score, 1) +
          " | Confidence: " + formatPercent(item.confidence, 1) +
          " | Type: " + item.analysis_type_label +
          "</li>";
      }).join("") + "</ol>";
    }

    document.getElementById("topLiftList").innerHTML = listHtml(topLift, "Lift");
    document.getElementById("topVolumeList").innerHTML = listHtml(topVolume, "Opportunity");
  }

  function renderTable(records, sortBy) {
    var topRows = sortRecords(records, sortBy).slice(0, 250);
    document.getElementById("tableBody").innerHTML = topRows.map(function (row, index) {
      return "<tr>" +
        "<td>" + (index + 1) + "</td>" +
        '<td><span class="pill ' + (row.analysis_type === "cross_category" ? "cross" : "within") + '">' + row.analysis_type_label + "</span></td>" +
        "<td>" + row.category_antecedent + "</td>" +
        "<td>" + row.category_consequent + "</td>" +
        "<td>" + row.antecedent_name + "</td>" +
        "<td>" + row.consequent_name + "</td>" +
        '<td class="num">' + formatNumber(row.opportunity_score, 1) + "</td>" +
        '<td class="num">' + formatNumber(row.pair_count) + "</td>" +
        '<td class="num">' + formatNumber(row.support, 4) + "</td>" +
        '<td class="num">' + formatPercent(row.confidence, 1) + "</td>" +
        '<td class="num">' + formatNumber(row.lift, 2) + "</td>" +
        '<td class="num">' + formatNumber(row.leverage, 4) + "</td>" +
        '<td class="num">' + row.itemset_size + "</td>" +
        "</tr>";
    }).join("");
  }

  function updateStats(records) {
    var s = summarize(records);
    document.getElementById("statsLine").innerHTML =
      '<span>Filtered rules: <strong>' + formatNumber(s.totalRules) + '</strong></span>' +
      '<span>Total pair count: <strong>' + formatNumber(s.totalPairCount) + '</strong></span>' +
      '<span>Average confidence: <strong>' + formatPercent(s.avgConfidence, 1) + '</strong></span>' +
      '<span>Average lift: <strong>' + formatNumber(s.avgLift, 2) + '</strong></span>';
  }

  // ─── Orchestration ─────────────────────────────────────
  function rerender() {
    var filters = getFilterState();
    var filtered = filterRecords(ALL_RECORDS, filters);
    renderKpis(filtered);
    renderCharts(filtered);
    renderTable(filtered, filters.sortBy);
    renderInsights(filtered);
    renderShortlists(filtered);
    updateStats(filtered);
  }

  function exportCsv() {
    var filters = getFilterState();
    var rows = sortRecords(filterRecords(ALL_RECORDS, filters), filters.sortBy);
    var headers = [
      "analysis_type", "category_antecedent", "category_consequent",
      "antecedent_name", "consequent_name", "opportunity_score",
      "pair_count", "support", "confidence", "lift", "leverage",
      "conviction", "itemset_size"
    ];

    function escapeValue(value) {
      if (value === null || value === undefined) return "";
      var text = String(value).replace(/"/g, '""');
      return /[",\n]/.test(text) ? '"' + text + '"' : text;
    }

    var csvRows = [headers.join(",")].concat(
      rows.map(function (row) {
        return headers.map(function (h) { return escapeValue(row[h]); }).join(",");
      })
    );

    var blob = new Blob([csvRows.join("\n")], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "market_basket_filtered_export.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function resetFilters() {
    document.getElementById("analysisType").value = "all";
    document.getElementById("itemsetSize").value = "all";
    document.getElementById("antecedentCategory").value = "all";
    document.getElementById("consequentCategory").value = "all";
    document.getElementById("sortBy").value = "opportunity_score_desc";
    rerender();
  }

  function attachEvents() {
    ["analysisType", "itemsetSize", "antecedentCategory", "consequentCategory", "sortBy"]
      .forEach(function (id) {
        document.getElementById(id).addEventListener("input", rerender);
      });
    document.getElementById("exportBtn").addEventListener("click", exportCsv);
    document.getElementById("resetBtn").addEventListener("click", resetFilters);
  }

  function init() {
    document.getElementById("generated-at").textContent = "Loaded: " + new Date().toLocaleString();
    populateFilters();
    attachEvents();
    rerender();
  }

  // ─── Tableau Extension Bootstrap ────────────────────────
  function initializeExtension() {
    // Attach toggle events immediately (before data load)
    document.querySelectorAll(".section-toggle").forEach(function (button) {
      button.addEventListener("click", function () {
        var section = document.getElementById(button.dataset.target);
        var collapsed = section.classList.toggle("is-collapsed");
        button.textContent = collapsed ? "Show" : "Hide";
        button.setAttribute("aria-expanded", collapsed ? "false" : "true");
        // Resize charts when Visual Analysis is expanded
        if (!collapsed && button.dataset.target === "visualAnalysisSection") {
          setTimeout(function () {
            Plotly.Plots.resize("topCategoryChart");
            Plotly.Plots.resize("crossFlowChart");
            Plotly.Plots.resize("scatterChart");
          }, 100);
        }
      });
    });

    tableau.extensions.initializeAsync().then(function () {
      var dashboard = tableau.extensions.dashboardContent.dashboard;

      // Populate worksheet selector
      var wsSelect = document.getElementById("worksheetSelect");
      dashboard.worksheets.forEach(function (ws) {
        wsSelect.innerHTML += optionHtml(ws.name, ws.name);
      });

      // Restore saved worksheet selection
      var savedSheet = tableau.extensions.settings.get("worksheet");
      if (savedSheet && dashboard.worksheets.some(function (ws) { return ws.name === savedSheet; })) {
        wsSelect.value = savedSheet;
        var ws = dashboard.worksheets.find(function (ws) { return ws.name === savedSheet; });
        selectedWorksheet = ws;
        loadWorksheetData(ws);
      }

      // Load Data button
      document.getElementById("loadDataBtn").addEventListener("click", function () {
        var sheetName = wsSelect.value;
        if (!sheetName) {
          showError("Please select a worksheet first.");
          return;
        }
        hideError();
        selectedWorksheet = dashboard.worksheets.find(function (ws) { return ws.name === sheetName; });
        if (!selectedWorksheet) {
          showError("Worksheet not found: " + sheetName);
          return;
        }

        // Save selection
        tableau.extensions.settings.set("worksheet", sheetName);
        tableau.extensions.settings.saveAsync();

        loadWorksheetData(selectedWorksheet);
      });

      // Register filter change listeners on all worksheets
      function registerFilterListeners() {
        unregisterFilterFns.forEach(function (fn) { fn(); });
        unregisterFilterFns = [];

        dashboard.worksheets.forEach(function (ws) {
          var unregisterFn = ws.addEventListener(
            tableau.TableauEventType.FilterChanged,
            function () {
              if (selectedWorksheet && ws.name === selectedWorksheet.name) {
                loadWorksheetData(selectedWorksheet);
              }
            }
          );
          unregisterFilterFns.push(unregisterFn);
        });
      }

      registerFilterListeners();
    }, function (err) {
      showError("Failed to initialize Tableau Extension: " + err.toString());
      console.error("Init error:", err);
    });
  }

  // ─── Start ─────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", initializeExtension);
})();
