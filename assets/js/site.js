/* Seulki Kim, site behavior: section highlight, paper overviews, filters. */
(function () {
  "use strict";

  // Paper overviews, opened from cards and the publication list.
  var PAPERS = {
    unipim: {
      thread: "t-pim", short: "UniPIM", venue: "HPCA 2027",
      title: "UniPIM: Hardware-Aligned Sparse LLM Inference for All-Bank Processing-in-Memory",
      figure: "assets/images/papers/unipim.svg",
      alt: "Index-based sparse PIM gives each DRAM bank different work and large index metadata; UniPIM uses a small bitmap and 32-byte blocks with equal work per bank.",
      prior: "Commercial bank-level PIM places a fixed-function MAC beside each DRAM bank. Pruning rarely pays off there: the MACs cannot skip zeros, CSR/COO index metadata can exceed the storage that pruning saves, and an all-bank input broadcast can be skipped only when no bank needs it.",
      insight: "Sparsity helps PIM only when it matches how the hardware moves data: in datapath-width blocks, with the same amount of work in every bank.",
      approach: "UniPIM stores retained data as bitmap-indexed blocks aligned to the 32-byte PIM datapath. All-bank pruning equalizes per-column work during compression, so banks stay synchronized without extra scheduling hardware. The same layout serves static weights and the evolving KV cache, and a small staging window handles independent pruning when the balance constraint costs accuracy.",
      result: "Up to 62% compression relative to FP16 on OPT-6.7B. Over C4 perplexity budgets of 16–30, decode throughput improves by up to 29% over quantized dense PIM at 7–23% lower energy, reaching 2.2–2.7× NPU throughput. Up to 2.1× the throughput of SparsePIM with 6.2% area overhead."
    },
    smooth: {
      thread: "t-device", short: "SMOOTH", venue: "ISCA 2026",
      title: "SMOOTH: Hardware-Assisted Fine-Grained On-Chip Memory Management for Efficient On-Device LLM Inference",
      figure: "assets/images/papers/smooth.svg",
      alt: "Bandwidth timelines: static tiling leaves bandwidth idle during compute phases; SMOOTH preloads weights into the idle windows and finishes decoding earlier.",
      prior: "Compilers plan on-chip SRAM statically with memory tiling and lifetime-based allocation. On mobile SoCs with 2–8 MB of SRAM and 13–34 GB/s LPDDR5, a fixed plan cannot follow runtime-dependent KV-cache sizes, token lengths, or bandwidth contention from the CPU and GPU.",
      insight: "Autoregressive decoding alternates between compute-bound and I/O-bound phases, so memory bandwidth sits idle in short, unpredictable windows. Capturing that slack needs runtime management at fine granularity.",
      approach: "SMOOTH manages the scratchpad in fine-grained blocks and preloads upcoming weights into idle bandwidth. A hardware early-reclamation mechanism uses buffer-level signals to release blocks as soon as they are no longer needed, making room for earlier preloading. It is implemented in Verilog and integrated into LLMCompass for cycle-accurate evaluation.",
      result: "Up to 59.2% lower Time-to-First-Token and 73.0% lower Time-to-Last-Token than prior baselines on memory-constrained mobile SoCs, with average energy reductions of up to 51.2%."
    },
    sanns: {
      thread: "t-search", short: "S-ANNS", venue: "IEEE CAL 2026",
      title: "S-ANNS: Energy-Efficient Approximate Nearest Neighbor Search via Shift-Based PIM Architecture",
      figure: "assets/images/papers/sanns.svg",
      alt: "A float32 value multiplied in an FP32 MAC versus the same value stored as signed powers of two and computed with shifts and an adder.",
      prior: "ANNS behind retrieval-augmented generation, recommendation, and vector databases is memory-bandwidth bound at billion scale. DPU-based PIM can run Product Quantization, but its general-purpose cores take DRAM capacity; MAC-based bank-level PIM streams only scalar-quantized vectors and cannot serve PQ lookup tables without scattered reads.",
      insight: "The recoding a multiplier performs at runtime depends only on the stored operand, and database vectors never change. That recoding can be done once, offline.",
      approach: "S-ANNS applies Power-of-Two quantization offline, encoding each float32 dimension as a few signed power-of-two terms stored directly in DRAM. The code is both a compressed format and a precomputed partial-product schedule, so a shift-and-add PE replaces the FP32 multiplier, and the number of terms S trades accuracy for efficiency.",
      result: "Relative to an FP32 MAC, the shift PE cuts per-dimension area and power by 49.4% and 58.9% at S=2. At S=4 the recall loss is at most 0.7 percentage points. On GIST1M, MSTuring1B, DEEP1B, and T2I-100M at recall@10 of 0.9, S-ANNS delivers 1.4–1.9× higher search throughput at 0.3–0.7× the memory footprint."
    },
    blockpim: {
      thread: "t-pim", short: "BlockPIM", venue: "IEEE CAL 2026",
      title: "BlockPIM: Enabling Sparse LLM Inference on Dense PIM Architectures",
      figure: "assets/images/papers/blockpim.svg",
      alt: "Unstructured pruning with CSR indices versus BlockPIM's 32-byte block pruning with a one-bit-per-block bitmap feeding a dense MAC pipeline.",
      prior: "Sparse PIM designs rely on CSR/COO formats that pay off only at ultra-high sparsity (above 90%), which practical LLMs cannot reach without accuracy loss. Under low-bit quantization, per-element indices can outweigh the weights they describe.",
      insight: "Prune at the granularity the PIM already reads, its 32-byte I/O. Sparse data then needs only a bitmap and can run on the dense pipeline.",
      approach: "BlockPIM applies hardware-aligned coarse-grained pruning, replaces per-element indices with compact bitmaps, and stores non-zero blocks contiguously. Standard dense MAC units compute over the blocks; the bitmap is used only to place partial results during accumulation.",
      result: "10–30% memory reduction under strict accuracy constraints where sparse engines are ineffective. Up to 8.0× speedup over an NPU and 3.6× over state-of-the-art sparse PIM, with up to 95.2% lower energy than the NPU."
    },
    ecocore: {
      thread: "t-system", short: "EcoCore", venue: "MICRO 2025",
      title: "EcoCore: Dynamic Core Management for Improving Energy Efficiency in Latency-Critical Applications",
      prior: "Cloud resource management works at the node or instance level, leaving idle cores that still consume energy. Core-management studies allocate cores to application threads but overlook network packet processing.",
      insight: "Packet processing needs its own core allocation, and its processing interval can be co-managed to lengthen core idleness without breaking SLOs.",
      approach: "EcoCore jointly manages cores for application threads and for packet processing and adapts packet-processing intervals, using a lightweight predictive model of energy and tail latency to pick configurations.",
      result: "11.7% lower energy on average and up to 20.3% without SLO violations. On AWS, core sleep states last up to 45.9% longer, for up to 35.8% additional energy savings."
    }
  };

  // Highlight the current section in the top nav.
  var navLinks = Array.prototype.slice.call(document.querySelectorAll('.site-nav a[href^="#"]'));
  if (navLinks.length && "IntersectionObserver" in window) {
    var byId = {};
    navLinks.forEach(function (a) { byId[a.getAttribute("href").slice(1)] = a; });
    var atBottom = function () { return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4; };
    var setActive = function (a) {
      navLinks.forEach(function (x) { x.classList.remove("is-active"); });
      a.classList.add("is-active");
      // On phones the nav row scrolls sideways; keep the current item in view.
      var nav = a.parentNode;
      if (nav.scrollWidth > nav.clientWidth) nav.scrollLeft = a.offsetLeft - nav.offsetLeft - 16;
    };
    var markLast = function () { setActive(navLinks[navLinks.length - 1]); };
    var spy = new IntersectionObserver(function (entries) {
      if (atBottom()) return markLast();
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var a = byId[e.target.id];
        if (a) setActive(a);
      });
    }, { rootMargin: "-30% 0px -60% 0px" });
    Object.keys(byId).forEach(function (id) { var s = document.getElementById(id); if (s) spy.observe(s); });
    // The last section is too short to reach the spy band, so mark it at the page bottom.
    window.addEventListener("scroll", function () { if (atBottom()) markLast(); }, { passive: true });
  }

  // Overview dialog.
  var dialog = null;
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
  }
  function tier(venue) {
    if (/^(HPCA|ISCA|MICRO|ASPLOS)\b/.test(venue)) return '<span class="tier tier-top">Top-tier</span>';
    if (/CAL\b/.test(venue)) return '<span class="tier tier-sci">SCI</span>';
    return "";
  }
  function openOverview(key, opener) {
    var p = PAPERS[key];
    if (!p) return;
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.className = "overview-dialog";
      dialog.setAttribute("aria-labelledby", "overview-title");
      document.body.appendChild(dialog);
      dialog.addEventListener("click", function (e) { if (e.target === dialog) dialog.close(); });
      dialog.addEventListener("close", function () { if (dialog._opener) dialog._opener.focus(); });
    }
    var rows = [["Prior work", p.prior], ["Key insight", p.insight], ["Approach", p.approach], ["Result", p.result]]
      .map(function (r) { return "<div><dt>" + r[0] + "</dt><dd>" + esc(r[1]) + "</dd></div>"; }).join("");
    dialog.className = "overview-dialog " + p.thread;
    dialog.innerHTML =
      '<div class="overview-inner">' +
        '<div class="overview-head"><div>' +
          '<p class="meta"><span class="venue">' + esc(p.venue) + "</span>" + tier(p.venue) + "</p>" +
          '<h2 id="overview-title">' + esc(p.short) + "</h2>" +
        "</div>" +
        '<button class="overview-close" type="button" aria-label="Close">×</button></div>' +
        '<p class="overview-full-title">' + esc(p.title) + "</p>" +
        (p.figure ? '<figure class="overview-figure"><img src="' + p.figure + '" alt="' + esc(p.alt) + '" width="760" height="400"></figure>' : "") +
        '<dl class="overview-text">' + rows + "</dl>" +
      "</div>";
    dialog.querySelector(".overview-close").addEventListener("click", function () { dialog.close(); });
    dialog._opener = opener;
    if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
  }
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-overview]");
    if (t) { e.preventDefault(); openOverview(t.getAttribute("data-overview"), t); }
  });

  // Publication filters.
  var filterBar = document.querySelector(".filters");
  if (filterBar) {
    filterBar.addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-filter]");
      if (!btn) return;
      var f = btn.getAttribute("data-filter");
      filterBar.querySelectorAll("button").forEach(function (b) { b.setAttribute("aria-pressed", String(b === btn)); });
      document.querySelectorAll(".pub").forEach(function (p) {
        var show = f === "all" || (f === "first" ? p.hasAttribute("data-first") : p.classList.contains(f));
        p.classList.toggle("is-hidden", !show);
      });
      document.querySelectorAll(".pub-year").forEach(function (y) {
        var visible = y.querySelectorAll(".pub:not(.is-hidden)");
        y.classList.toggle("is-empty", !visible.length);
        y.querySelectorAll(".pub").forEach(function (p) { p.classList.remove("is-last"); });
        if (visible.length) visible[visible.length - 1].classList.add("is-last");
      });
    });
  }

  // Links from the home list open this page at a paper; make sure we land there
  // even if the browser skipped the initial fragment scroll.
  if (location.hash.length > 1) {
    window.addEventListener("load", function () {
      var target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (target && window.scrollY === 0) target.scrollIntoView();
    });
  }
})();
