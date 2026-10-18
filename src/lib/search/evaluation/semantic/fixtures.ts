import type { SemanticEvaluationDocument, SemanticEvaluationQuery } from "./types";

type EightTexts = readonly [string, string, string, string, string, string, string, string];

/** Every sentence is invented. The last five records in each group add near misses. */
const groups: readonly { id: string; texts: EightTexts }[] = [
  { id: "retry", texts: [
    "A checkout request can arrive twice after a connection drops. Keep the same operation key and return the first saved receipt instead of charging again.",
    "When a payment response gets lost, repeating the purchase should reuse its original token. Save the token and outcome together in one transaction.",
    "Idempotency-Key belongs to one purchase attempt. Reuse it for a retry, but create a fresh value for a genuinely new purchase.",
    "An exponential backoff schedule spaces retries apart, but spacing alone cannot prevent a repeated payment from taking money twice.",
    "A unique visitor counter estimates how many browsers opened the shop. It does not identify a purchase operation.",
    "Our orchestra repeats the opening charge of brass after a short rest; the conductor keeps the same tempo.",
    "A receipt printer needs new paper before the lunch rush. The spare roll fits beneath the counter.",
    "A refund is a separate operation from the original sale and needs its own approval trail.",
  ] },
  { id: "pagination", texts: [
    "For a scrolling reading list, continue after the last pair of publication time and unique row ID. The second field breaks ties between posts with identical times.",
    "A stable cursor remembers both the last date and the last identifier. Sort the next page by that same pair so equal dates cannot hide a row.",
    "Keyset pagination uses a compound cursor when the first sort column is not unique. Test several records sharing one timestamp.",
    "Offset pagination is convenient for jumping to page twenty, but inserting a new first row can shift the later pages.",
    "A mouse cursor can become hard to see against a white slide. Give the pointer a dark outline.",
    "Sort the bibliography alphabetically by title before printing the booklet; no incremental page requests are involved.",
    "Our diary lists an event date separately from the date somebody typed it into the notebook.",
    "A limit of ten keeps a page small, but a page size does not define how tied records are ordered.",
  ] },
  { id: "locks", texts: [
    "Two transfers can freeze each other when one grabs account A then B while the other grabs B then A. Always acquire account locks in identifier order.",
    "Pick one global order for taking shared resources. Every transaction follows it, so no worker can hold the later resource while waiting for the earlier one.",
    "Deadlock prevention starts with consistent lock ordering; a timeout only detects that waiting has lasted too long.",
    "A transaction timeout helps a stuck request fail eventually, but it does not remove a cycle of workers waiting on each other.",
    "Sort the account statement by merchant name for easier reading. This display order has no effect on transaction locks.",
    "The bicycle lock froze overnight. Warm the key gently before trying the mechanism again.",
    "A semaphore limits the number of concurrent downloads; it does not prescribe the order of two account locks.",
    "Optimistic version checks reject an outdated edit after a race. They solve a different problem from cyclic lock acquisition.",
  ] },
  { id: "restore", texts: [
    "A green backup job is only the start. Rebuild the service in an isolated sandbox and open a few restored records before trusting the recovery plan.",
    "Practice recovering yesterday's snapshot onto a separate machine. Measure when the application becomes usable and compare important rows with the originals.",
    "A restore drill tests both recoverable data and the instructions needed to bring the application back.",
    "Keeping a second copy in another region protects against one site's failure, but a copy count alone does not prove it can be read.",
    "Restoring a scratched chair begins by removing the old varnish. Keep the sanding dust away from wet paint.",
    "The dashboard shows that the nightly copy finished at 02:10. Nobody has tried opening that copy yet.",
    "A photo album makes a comforting backup of a holiday memory, even when the original camera is gone.",
    "A migration rehearsal tests a schema change on copied data. It is not a timed recovery from lost infrastructure.",
  ] },
  { id: "offline", texts: [
    "Let a field note save on the device while the signal is gone. Keep it in a durable outgoing list and send it when connectivity returns.",
    "An offline editor marks unsent changes as pending, stores them across restarts, and clears each entry only after the server acknowledges it.",
    "The outbox pattern separates a local save from eventual delivery. A reopened app can resume pending sends.",
    "Caching a downloaded map lets travelers view it without reception, but it does not upload edits made on the trip.",
    "Disable the submit button while offline if the form has no local storage; otherwise the screen may promise a save that disappears.",
    "An email draft remains unfinished until its author chooses to send it. It is not an acknowledged outgoing operation.",
    "A durable notebook cover survives rain better than thin cardboard. The paper inside still needs protection.",
    "A connection badge reports that Wi-Fi is available; it cannot prove the remote service accepted a particular note.",
  ] },
  { id: "focus", texts: [
    "When a modal opens, move keyboard focus inside it. Keep Tab within the active dialog and return focus to the opener after dismissal.",
    "A keyboard user should be able to enter a pop-up, reach every action, close it with Escape, and continue at the button that launched it.",
    "Focus restoration prevents a closed dialog from leaving the keyboard user stranded at the start of the page.",
    "A visible focus ring helps people find the selected control, but drawing a ring does not trap navigation inside a modal.",
    "A camera's autofocus hunts in low light. Point it at an edge with more contrast before taking the picture.",
    "A tooltip describes a nearby icon on hover. It is not an interactive dialog and should not capture keyboard navigation.",
    "Make touch targets generous enough for an uncertain finger. Target size alone does not define a tab sequence.",
    "The reading group reserves its first ten minutes for quiet focus before discussion begins.",
  ] },
  { id: "color", texts: [
    "A form error needs words beside the field, not just a red border. People who cannot distinguish that hue still need the same correction instructions.",
    "Pair a warning color with an icon and a readable label. The status must survive when the interface is viewed in grayscale.",
    "Redundant status cues combine text, shape, and color so meaning does not depend on hue perception.",
    "A contrast checker measures whether foreground and background differ enough; it does not explain what a red-only status means.",
    "Use a sequential palette for rainfall totals. The map's legend can describe amounts, but a palette is not a form validation message.",
    "The red warning light in the stage set is a prop with no operational meaning for the audience.",
    "A screen reader label on an unlabeled icon helps speech output, while a visible text cue also helps sighted users who confuse colors.",
    "Paint the storage boxes in three cheerful colors, then put identical blank lids on every box.",
  ] },
  { id: "interview", texts: [
    "Instead of asking whether people love a proposed feature, ask them to describe the last time they tried to solve the problem. Listen for what they actually did.",
    "A useful research prompt asks for a recent concrete episode without naming the solution you hope they will praise.",
    "Neutral interview questions invite past behavior and leave room for an answer that contradicts the team's idea.",
    "A satisfaction poll can measure an opinion after release. It cannot replace a detailed account of how someone handled yesterday's task.",
    "A job interview may need a structured scoring rubric so every candidate gets the same opportunity to demonstrate a skill.",
    "Ask whether our brilliant new planner would save hours every day; this wording almost supplies the desired answer.",
    "A microphone check before the recording prevents a silent file, but it does not remove leading wording from questions.",
    "Five minutes of friendly conversation can help participants relax before a research session begins.",
  ] },
  { id: "layout", texts: [
    "Reserve an image's width and height before its bytes arrive. The article stays still instead of pushing the paragraph down when the photo loads.",
    "An aspect-ratio box keeps space for a slow-loading picture, so readers do not lose their place as the page finishes drawing.",
    "Cumulative Layout Shift falls when late media has reserved dimensions. A smaller file can still cause movement if its space was missing.",
    "Lazy loading defers offscreen image downloads. It reduces early traffic, but an image without reserved space can still shove nearby text.",
    "A responsive picture chooses an appropriate resolution for the screen. Resolution selection alone does not allocate vertical space.",
    "The photographer shifted a chair two meters left to improve the portrait's composition.",
    "Compressing a photo makes the transfer shorter. It does not guarantee that the browser knows its eventual height.",
    "A fixed header can cover an anchor target unless the document leaves enough scroll margin.",
  ] },
  { id: "rates", texts: [
    "Two neighborhoods cannot be compared fairly by incident counts when one has ten times as many residents. Show incidents per resident and keep the denominator visible.",
    "Compare failures per thousand requests rather than raw failures when traffic volumes differ. Report both the rate and how many requests it describes.",
    "Denominator neglect makes a busy service look less reliable just because it handles more work. Normalize by exposure before comparing.",
    "A total count answers how much work exists, which is useful for staffing; it does not by itself answer how risky each request is.",
    "An interest rate describes the price of borrowing. It is not a denominator for comparing two neighborhoods' incident totals.",
    "A logarithmic axis can fit very large counts on one chart, but changing the axis does not adjust for population.",
    "The concert sold twice as many tickets after adding a second night. The venue still needs the raw attendance to plan cleaning.",
    "A moving average smooths daily spikes. Smoothing alone cannot make differently sized populations comparable.",
  ] },
  { id: "cache", texts: [
    "After saving an edited note, invalidate the cached detail and list entries that contain it. Otherwise a successful save can still display yesterday's words.",
    "Treat a write and the cached views it affects as one plan. Refresh every dependent read after the server confirms the change.",
    "Cache invalidation after mutation keeps the detail panel and its list summary consistent with the persisted note.",
    "A short time-to-live eventually removes stale entries, but the author may still see an old value immediately after saving.",
    "A hardware cache line groups nearby bytes for the processor. It has no knowledge of which web note somebody edited.",
    "Preloading the next page makes navigation faster. It does not remove the old copy of a changed item from an existing cache.",
    "An optimistic screen can show the edit before confirmation, but it still needs a plan for refresh and server rejection.",
    "Caching an immutable book-cover image under a content hash is easier than caching a mutable note under a permanent URL.",
  ] },
  { id: "logs", texts: [
    "Record a request identifier and a safe error category when a private form fails. Do not copy its submitted message or credentials into the log.",
    "Build structured diagnostics from an allowlist of operational fields. A full request dump can quietly retain passwords and personal writing.",
    "Log redaction should happen before serialization, and tests should use planted fake secrets to check that the output omits them.",
    "Encrypting the log disk helps if the disk is stolen, but every authorized log reader can still see any secret that was recorded.",
    "A log cabin needs a roof overhang to keep rain away from the end grain. Its timber has no diagnostic fields.",
    "A private dashboard does not make a copied password harmless. Minimize what the diagnostic record contains first.",
    "Record a public build version to connect an error to a release. This is operational metadata rather than form content.",
    "A database backup retains data for recovery; an error log should not become an accidental second archive of user messages.",
  ] },
  { id: "battery", texts: [
    "A browser task should pause heavy indexing when the tab is hidden and process short chunks when visible. Yield between chunks so the phone remains responsive.",
    "Let the owner pause local computation and resume from a checkpoint. Small batches avoid monopolizing a mobile device while it is doing other work.",
    "Cooperative scheduling gives long browser work regular yield points; moving work to a worker alone does not eliminate energy use.",
    "WebGPU can make a supported workload faster, but GPU availability does not guarantee that continuous background computation is cheap for a battery.",
    "A battery icon can display remaining charge without controlling the amount of work an application performs.",
    "A drum battery carries the marching band's rhythm across the field. Each player waits for the next musical cue.",
    "A Web Worker moves calculations away from the main thread. It can still run continuously while the page is invisible.",
    "Turning the screen brightness down may save energy, but it does not create a checkpoint for interrupted computation.",
  ] },
  { id: "vectors", texts: [
    "Store the encoder version with every document vector. When the encoder changes, rebuild the collection before comparing new query vectors with old records.",
    "Equal vector lengths do not prove that two encoders share a coordinate system. Keep query and document model revisions aligned during a reindex.",
    "An embedding space is defined by model revision, pooling, and normalization together; matching dimensions alone is insufficient.",
    "A stale text hash means the record's words changed and its vector needs regeneration, even if the encoder itself stayed the same.",
    "A vector illustration stays sharp at any display size. Its drawing paths are unrelated to an encoder's numerical coordinates.",
    "Changing a nearest-neighbor index's tuning may change latency without changing the underlying encoder space.",
    "Normalizing a vector controls its length but cannot translate it into a different model's learned coordinate system.",
    "A model card can describe language limitations. Reading it does not convert existing English embeddings into multilingual ones.",
  ] },
  { id: "properties", texts: [
    "Instead of listing only a few sorted arrays, generate many inputs and check that sorting preserves every element and never leaves a descending adjacent pair.",
    "Write a rule that must hold for every generated case, then shrink a failing input until the counterexample is easy to understand.",
    "Property-based testing explores invariants across generated inputs; shrinking explains the smallest observed failure.",
    "A snapshot test records one output for one input. It can catch a change but does not explore a broad input space by itself.",
    "The rental property has two bedrooms and a shared garden. Its inspection checklist is not a generated software test.",
    "A performance benchmark times a workload. Fast execution does not prove that sorting preserved duplicate elements.",
    "Use a reproducible random seed to replay a generated failure. A seed supports debugging but is not itself a correctness invariant.",
    "A type checker catches incompatible types before execution. It cannot establish every runtime ordering property.",
  ] },
  { id: "freezer", texts: [
    "Cook a pot of beans once, cool it promptly, and freeze flat meal-sized portions. A small packet thaws faster than a solid block when dinner is rushed.",
    "Label cooked lentils with the preparation date and divide them into shallow containers before freezing. Pull one serving instead of reheating the whole batch.",
    "Batch cooking works best when portions match one meal and labels make older frozen servings easy to find.",
    "Dry beans keep well in a sealed pantry jar, but uncooked storage does not provide a ready portion for tonight's dinner.",
    "A software process can freeze while waiting for a missing event. Dividing a meal will not repair that program.",
    "A large casserole can feed several guests. Freezing it as one slab makes a single quick lunch harder to retrieve.",
    "A fridge thermometer helps monitor cold storage. The reading alone does not divide a cooked batch into useful portions.",
    "Toast spices briefly before adding tomatoes for a richer sauce. This changes flavor rather than freezer organization.",
  ] },
  { id: "soil", texts: [
    "Before watering a potted herb, feel the soil below the surface and check the pot's weight. Yesterday's watering schedule cannot tell you whether today's roots are still wet.",
    "Let the growing medium guide irrigation. A light pot with dry soil needs attention sooner than a heavy pot whose lower soil remains damp.",
    "Soil moisture checks are more informative than a fixed watering calendar because heat, container size, and drainage change drying speed.",
    "Brown leaf tips can have several causes. Adding water without checking the root zone may worsen an already soggy pot.",
    "A calendar reminder can prompt a plant inspection, but following it blindly can overwater a slow-drying container.",
    "Watercolor paper buckles when very wet. Stretch the sheet before painting a broad wash.",
    "A rain gauge measures outdoor precipitation. An indoor pot behind glass may receive none of that rain.",
    "Pruning basil encourages branching above a leaf pair. It does not measure whether the soil needs water.",
  ] },
  { id: "packing", texts: [
    "For a trip with sudden rain, keep a dry base layer in a sealed inner bag. The outer pack can get soaked while the evening clothes stay usable.",
    "A pack liner protects the contents even when water gets through zippers. Put sleep clothes inside it before heading into unsettled weather.",
    "Waterproof packing separates dry essentials from wet outer gear instead of trusting every backpack seam to stay sealed.",
    "A rain jacket keeps the walker drier, but it does not prevent water from entering an uncovered bag.",
    "Packing a database into fewer disk pages changes storage density. It will not keep socks dry on a trail.",
    "A mesh pouch helps damp gloves air out; it is the wrong container for protecting a spare shirt from rain.",
    "A lighter suitcase is easier to carry upstairs. Weight reduction alone says nothing about water resistance.",
    "Check the forecast before departure, while remembering that mountain conditions can change after the download.",
  ] },
  { id: "learning", texts: [
    "Close the notes and try to explain the idea from memory, then check what was missing. Return to it after a longer gap once recall becomes easier.",
    "Spread short self-quizzes across several days. Retrieving an answer without looking makes weak understanding visible before the final exam.",
    "Spaced retrieval combines delayed practice with active recall; repeatedly rereading the same highlighted page does neither reliably.",
    "A colorful highlight can mark a useful passage, but recognizing that color is easier than reconstructing the argument unaided.",
    "A search engine retrieves a document from an index. That use of retrieval does not describe a student's memory practice.",
    "Cramming the entire chapter in one evening can create familiarity without testing what remains after several nights.",
    "A quiet desk removes distractions. It supports study but does not turn passive rereading into a recall attempt.",
    "An open-book exercise can teach source navigation, while a closed-note explanation tests a different skill.",
  ] },
  { id: "revision", texts: [
    "Give a draft to a reader who lacks the background, then ask them to explain its main point. Revise the places where their interpretation diverges from your intent.",
    "A fresh reader's paraphrase reveals missing links in an argument. Ask what they understood before explaining what you meant to say.",
    "Reader feedback is most useful when it describes an observed misunderstanding and the sentence that caused it.",
    "A spell checker can catch a typo in a paragraph whose logic is still impossible to follow.",
    "A software revision number identifies a build. Increasing that number does not make an essay easier to understand.",
    "Praise such as 'looks good' is pleasant but gives the writer little evidence about whether the argument was understood.",
    "Reading a draft aloud may reveal awkward rhythm. An independent reader can expose assumptions the writer still supplies automatically.",
    "Choose a consistent heading style after the argument works. Visual polish cannot fill a missing explanation.",
  ] },
];

function syntheticTweetId(index: number): string {
  // Deliberately synthetic and above Number.MAX_SAFE_INTEGER; never parse as Number.
  return `9900000000000000${String(index).padStart(3, "0")}`;
}

const primaryDocuments: readonly SemanticEvaluationDocument[] = groups.flatMap(
  (group, groupIndex) => group.texts.map((text, textIndex) => {
    const tweetId = syntheticTweetId(groupIndex * 8 + textIndex + 1);
    return {
      id: `${group.id}-${textIndex + 1}`,
      tweetId,
      canonicalUrl: `https://x.com/i/web/status/${tweetId}`,
      authorUsername: `fixture_${group.id}_${textIndex + 1}`,
      text,
      language: "en" as const,
    };
  }),
);

const contextDocuments: readonly Omit<SemanticEvaluationDocument, "tweetId" | "canonicalUrl" | "authorUsername">[] = [
  {
    id: "context-quote-1", language: "en", text: "A short response to the workshop sketch.",
    quotedText: "A moonwheel garden keeps seedlings in rotating trays so every sprout gets its turn at the window.",
  },
  {
    id: "context-quote-2", language: "en", text: "Keeping this reader's demonstration for later.",
    quotedText: "A paper bridge folded into a zigzag can carry more coins than the same sheet laid flat.",
  },
  {
    id: "context-note-1", language: "en", text: "A plain card from the weekend desk.",
    note: "Project lantern desk: turn the old cupboard into a standing workstation with a shallow keyboard shelf.",
    tags: ["weekend-build", "lantern-desk"],
  },
  {
    id: "context-tags-1", language: "en", text: "A small reminder to revisit this saved item.",
    note: "Bring a spare pair of wool socks for the ferry crossing.", tags: ["copper-compass", "journey-kit"],
  },
  {
    id: "language-es-1", language: "es",
    text: "Una caja de herramientas compartida funciona mejor si cada pieza tiene una silueta dibujada y vuelve a su sitio después de usarse.",
  },
  {
    id: "language-fr-1", language: "fr",
    text: "Pour observer les étoiles loin des lampadaires, laisse tes yeux s'habituer à l'obscurité et utilise une faible lumière rouge pour lire la carte du ciel.",
  },
  {
    id: "language-de-1", language: "de",
    text: "Eine Fahrradkette läuft leiser, wenn man Schmutz entfernt, sparsam schmiert und überschüssiges Öl abwischt.",
  },
  {
    id: "language-ms-1", language: "ms",
    text: "Bawa bekas sendiri ke pasar untuk mengasingkan rempah pukal, dan tulis nama serta tarikh belian pada setiap penutup.",
  },
];

export const SYNTHETIC_SEMANTIC_DOCUMENTS: readonly SemanticEvaluationDocument[] = [
  ...primaryDocuments,
  ...contextDocuments.map((document, index) => {
    const tweetId = syntheticTweetId(primaryDocuments.length + index + 1);
    return {
      ...document,
      tweetId,
      canonicalUrl: `https://x.com/i/web/status/${tweetId}`,
      authorUsername: `fixture_context_${index + 1}`,
    };
  }),
];

/**
 * Judgments were authored against the complete invented corpus, not derived from
 * a ranker, a model, or shared topic labels. See README.md for scope and grading.
 */
export const SYNTHETIC_SEMANTIC_QUERIES: readonly SemanticEvaluationQuery[] = [
  { id: "retry-concept", kind: "conceptual", query: "How can a lost purchase response be retried without taking money twice?", relevance: { "retry-1": 3, "retry-2": 3, "retry-3": 2, "retry-4": 1 }, rationale: "Operation identity and stored outcomes address duplicate charges; spacing requests alone is only a warning, and visitor identity is unrelated." },
  { id: "retry-paraphrase", kind: "paraphrase", query: "The shop never answered, so I clicked buy again. Keep that as one sale.", relevance: { "retry-1": 3, "retry-2": 3, "retry-3": 2 }, rationale: "These three specify reusing purchase identity; a refund or a new purchase is a separate operation." },
  { id: "retry-literal", kind: "lexical", query: "Idempotency-Key", relevance: { "retry-3": 3 }, rationale: "The named technical header appears in this record only." },
  { id: "retry-id", kind: "exact", query: "9900000000000000001", relevance: { "retry-1": 3 }, rationale: "Exact synthetic tweet identity, independent of similar payment wording." },

  { id: "pagination-concept", kind: "conceptual", query: "How do I scroll through dated posts without losing items that share the same time?", relevance: { "pagination-1": 3, "pagination-2": 3, "pagination-3": 2, "pagination-8": 1 }, rationale: "A date-plus-ID ordering resolves ties; page size alone is only a caution, and pointer visibility is a different sense of cursor." },
  { id: "pagination-paraphrase", kind: "paraphrase", query: "Continue after both the previous date and its unique identifier so tied entries stay reachable.", relevance: { "pagination-1": 3, "pagination-2": 3, "pagination-3": 2 }, rationale: "These records describe the compound continuation point; offset jumps and printed bibliography order do not." },
  { id: "pagination-literal", kind: "lexical", query: '"Keyset pagination"', relevance: { "pagination-3": 3 }, rationale: "Only this record contains the requested phrase." },
  { id: "pagination-url", kind: "exact", query: "https://x.com/i/web/status/9900000000000000009", relevance: { "pagination-1": 3 }, rationale: "A canonical synthetic status URL identifies one post." },

  { id: "locks-concept", kind: "conceptual", query: "Two bank transfers each hold the resource the other needs. How do we stop this circular wait?", relevance: { "locks-1": 3, "locks-2": 3, "locks-3": 2, "locks-4": 1 }, rationale: "Consistent acquisition order prevents cycles; timeouts describe detection only and statement display order is irrelevant." },
  { id: "locks-paraphrase", kind: "paraphrase", query: "Make all transactions grab shared accounts in the same sequence.", relevance: { "locks-1": 3, "locks-2": 3, "locks-3": 2 }, rationale: "The first three explain a common lock order; optimistic edit versions solve a different race." },
  { id: "locks-literal", kind: "lexical", query: '"Deadlock prevention"', relevance: { "locks-3": 3 }, rationale: "The exact prevention phrase is present only here." },
  { id: "locks-handle", kind: "exact", query: "@fixture_locks_1", relevance: { "locks-1": 3 }, rationale: "Every invented author handle is unique to its document." },

  { id: "restore-concept", kind: "conceptual", query: "How can we know the saved copy will actually bring our service back after a loss?", relevance: { "restore-1": 3, "restore-2": 3, "restore-3": 2, "restore-4": 1, "restore-6": 1 }, rationale: "An isolated recovery exercise is direct evidence; copy counts and a green job are partial cautions rather than proof." },
  { id: "restore-paraphrase", kind: "paraphrase", query: "Rehearse rebuilding elsewhere and check that the recovered records open.", relevance: { "restore-1": 3, "restore-2": 3, "restore-3": 2 }, rationale: "These require exercising recovery; furniture restoration and schema migration rehearsals have different goals." },
  { id: "restore-literal", kind: "lexical", query: '"restore drill"', relevance: { "restore-3": 3 }, rationale: "The literal drill phrase names this document." },
  { id: "restore-phrase", kind: "exact", query: '"a green backup job"', relevance: { "restore-1": 3 }, rationale: "Only the first post has this contiguous phrase." },

  { id: "offline-concept", kind: "conceptual", query: "Save a note with no reception and deliver it later even if the app closes in between.", relevance: { "offline-1": 3, "offline-2": 3, "offline-3": 2 }, rationale: "Durable outgoing changes survive restarts; read-only map caching, drafts, and a connectivity badge do not establish delivery." },
  { id: "offline-paraphrase", kind: "paraphrase", query: "Keep unsent edits on the device until the remote service confirms receipt.", relevance: { "offline-1": 2, "offline-2": 3, "offline-3": 2, "offline-8": 1 }, rationale: "Acknowledgment and persisted pending sends match; the badge record warns why connectivity is insufficient." },
  { id: "offline-literal", kind: "lexical", query: '"outbox pattern"', relevance: { "offline-3": 3 }, rationale: "Only this post names the pattern explicitly." },
  { id: "offline-id", kind: "exact", query: "9900000000000000033", relevance: { "offline-1": 3 }, rationale: "Exact tweet identity must choose this record rather than another offline edit." },

  { id: "focus-concept", kind: "conceptual", query: "After opening and closing a pop-up, how does someone using only Tab get back to where they started?", relevance: { "focus-1": 3, "focus-2": 3, "focus-3": 2, "focus-4": 1 }, rationale: "Dialog focus management and restoration answer the navigation intent; a focus ring is only supporting and camera focus is unrelated." },
  { id: "focus-paraphrase", kind: "paraphrase", query: "Dismiss the dialog and put the active control back on its launch button.", relevance: { "focus-1": 3, "focus-2": 3, "focus-3": 3 }, rationale: "All three directly describe returning keyboard focus after dismissal; a noninteractive tooltip has different behavior." },
  { id: "focus-literal", kind: "lexical", query: '"Focus restoration"', relevance: { "focus-3": 3 }, rationale: "This is the sole contiguous occurrence of the phrase." },
  { id: "focus-url", kind: "exact", query: "https://x.com/i/web/status/9900000000000000041", relevance: { "focus-1": 3 }, rationale: "The URL maps to the first focus document only." },

  { id: "color-concept", kind: "conceptual", query: "Make a warning understandable to someone who cannot tell red from green.", relevance: { "color-1": 3, "color-2": 3, "color-3": 2, "color-4": 1, "color-7": 2 }, rationale: "Visible words, icons, and shapes preserve meaning; contrast alone is a partial caution, and a rainfall palette has another purpose." },
  { id: "color-paraphrase", kind: "paraphrase", query: "The form's red outline needs readable correction instructions beside it.", relevance: { "color-1": 3, "color-2": 2, "color-3": 2, "color-7": 1 }, rationale: "The field-specific message is direct; generic redundant cues support it, while a speech-only label is less complete for sighted readers." },
  { id: "color-literal", kind: "lexical", query: '"Redundant status cues"', relevance: { "color-3": 3 }, rationale: "The requested phrase names only this post." },
  { id: "color-handle", kind: "exact", query: "@fixture_color_1", relevance: { "color-1": 3 }, rationale: "An exact author lookup selects the one post assigned this invented handle." },

  { id: "interview-concept", kind: "conceptual", query: "How do I learn what people really do without nudging them to praise my proposed feature?", relevance: { "interview-1": 3, "interview-2": 3, "interview-3": 2, "interview-4": 1, "interview-6": 1 }, rationale: "Recent behavior and neutral prompts answer the intent; polls and a leading example are partial contrasts, while job scoring is a different task." },
  { id: "interview-paraphrase", kind: "paraphrase", query: "Ask for their most recent attempt at the task before suggesting our preferred solution.", relevance: { "interview-1": 3, "interview-2": 3, "interview-3": 2 }, rationale: "These elicit concrete past behavior without prescribing an answer; rapport and recording checks do not address wording." },
  { id: "interview-literal", kind: "lexical", query: '"Neutral interview questions"', relevance: { "interview-3": 3 }, rationale: "The phrase appears in this post only." },
  { id: "interview-phrase", kind: "exact", query: '"the last time they tried"', relevance: { "interview-1": 3 }, rationale: "This contiguous wording is unique to the first interview post." },

  { id: "layout-concept", kind: "conceptual", query: "Keep the paragraph under a slow photo from jumping away while I read.", relevance: { "layout-1": 3, "layout-2": 3, "layout-3": 2, "layout-4": 1, "layout-5": 1, "layout-7": 1 }, rationale: "Reserved image space fixes movement; download timing, resolution, and compression only explain why speed alone is insufficient." },
  { id: "layout-paraphrase", kind: "paraphrase", query: "Allocate a rectangle with the picture's proportions before the picture arrives.", relevance: { "layout-1": 3, "layout-2": 3, "layout-3": 2 }, rationale: "Dimensions and aspect-ratio placeholders directly reserve space; photographic composition is unrelated." },
  { id: "layout-literal", kind: "lexical", query: '"Cumulative Layout Shift"', relevance: { "layout-3": 3 }, rationale: "The named measurement appears only in this document." },
  { id: "layout-id", kind: "exact", query: "9900000000000000065", relevance: { "layout-1": 3 }, rationale: "This synthetic snowflake selects the first image-layout post." },

  { id: "rates-concept", kind: "conceptual", query: "Compare incident risk fairly when one place has many more people than the other.", relevance: { "rates-1": 3, "rates-2": 2, "rates-3": 2, "rates-4": 1, "rates-6": 1, "rates-8": 1 }, rationale: "Population or exposure denominators enable fair rates; changing axes or smoothing counts only supplies partial cautions." },
  { id: "rates-paraphrase", kind: "paraphrase", query: "A busier service has more errors; divide by handled requests before judging reliability.", relevance: { "rates-2": 3, "rates-3": 3, "rates-1": 2, "rates-4": 1 }, rationale: "Per-request comparisons are direct; the neighborhood example transfers the same principle, and staffing totals have a different purpose." },
  { id: "rates-literal", kind: "lexical", query: '"Denominator neglect"', relevance: { "rates-3": 3 }, rationale: "Only this record names denominator neglect." },
  { id: "rates-url", kind: "exact", query: "https://x.com/i/web/status/9900000000000000073", relevance: { "rates-1": 3 }, rationale: "The canonical status URL identifies the neighborhood comparison only." },

  { id: "cache-concept", kind: "conceptual", query: "The edit saved, but both the list and detail still show the old note. What should refresh?", relevance: { "cache-1": 3, "cache-2": 3, "cache-3": 3, "cache-4": 1, "cache-7": 1 }, rationale: "Dependent read invalidation fixes stale views; expiry and optimistic display are partial considerations rather than a complete refresh plan." },
  { id: "cache-paraphrase", kind: "paraphrase", query: "After a confirmed write, evict every stored view that includes the changed item.", relevance: { "cache-1": 3, "cache-2": 3, "cache-3": 3 }, rationale: "These explicitly connect mutations with all affected reads; preloading and processor cache lines do not." },
  { id: "cache-literal", kind: "lexical", query: '"Cache invalidation after mutation"', relevance: { "cache-3": 3 }, rationale: "The entire phrase occurs in this post alone." },
  { id: "cache-handle", kind: "exact", query: "@fixture_cache_1", relevance: { "cache-1": 3 }, rationale: "Exact synthetic author metadata is relevant regardless of semantic neighbors." },

  { id: "logs-concept", kind: "conceptual", query: "Diagnose a failed private form without leaving its message or password in retained diagnostics.", relevance: { "logs-1": 3, "logs-2": 3, "logs-3": 2, "logs-4": 1, "logs-6": 1, "logs-7": 2, "logs-8": 1 }, rationale: "Safe operational fields and pre-output redaction answer the intent; encryption and access restrictions alone still retain sensitive content." },
  { id: "logs-paraphrase", kind: "paraphrase", query: "Write only approved operational fields instead of dumping the whole incoming request.", relevance: { "logs-1": 3, "logs-2": 3, "logs-3": 2, "logs-7": 2 }, rationale: "The allowlist and examples directly minimize diagnostics; a log cabin is a word-sense distractor." },
  { id: "logs-literal", kind: "lexical", query: '"Log redaction"', relevance: { "logs-3": 3 }, rationale: "Only this record contains the requested phrase." },
  { id: "logs-phrase", kind: "exact", query: '"a request identifier and a safe error category"', relevance: { "logs-1": 3 }, rationale: "The exact contiguous phrase identifies the first logging post." },

  { id: "battery-concept", kind: "conceptual", query: "Keep long local computations from hogging a phone when the owner switches away.", relevance: { "battery-1": 3, "battery-2": 3, "battery-3": 2, "battery-4": 1, "battery-7": 1 }, rationale: "Visibility pauses, user control, and short yielding batches answer the intent; acceleration and worker placement alone do not limit ongoing work." },
  { id: "battery-paraphrase", kind: "paraphrase", query: "Run a little work, give other tasks a turn, and resume from where the user paused.", relevance: { "battery-1": 3, "battery-2": 3, "battery-3": 2 }, rationale: "Chunks, yielding, and checkpoints answer the intent; reproducing a generated test failure is a different task from resuming computation." },
  { id: "battery-literal", kind: "lexical", query: '"Cooperative scheduling"', relevance: { "battery-3": 3 }, rationale: "The explicit scheduling term occurs only here." },
  { id: "battery-id", kind: "exact", query: "9900000000000000097", relevance: { "battery-1": 3 }, rationale: "The exact ID identifies this post without relying on the overloaded word battery." },

  { id: "vectors-concept", kind: "conceptual", query: "Can equally long document and query arrays from different encoders be compared safely?", relevance: { "vectors-1": 3, "vectors-2": 3, "vectors-3": 3, "vectors-7": 2 }, rationale: "A shared embedding space requires matching contracts; equal length or normalization cannot translate between learned spaces." },
  { id: "vectors-paraphrase", kind: "paraphrase", query: "Upgrade the sentence encoder and rebuild old representations before searching with the replacement.", relevance: { "vectors-1": 3, "vectors-2": 3, "vectors-3": 2, "vectors-8": 1 }, rationale: "Version-aligned reindexing is direct; the language-model caution is partial, while text edits and index tuning are separate causes." },
  { id: "vectors-literal", kind: "lexical", query: '"embedding space"', relevance: { "vectors-3": 3 }, rationale: "Only this record has the exact singular phrase." },
  { id: "vectors-url", kind: "exact", query: "https://x.com/i/web/status/9900000000000000105", relevance: { "vectors-1": 3 }, rationale: "The exact synthetic URL selects one encoder-version post." },

  { id: "properties-concept", kind: "conceptual", query: "Explore many possible inputs and reduce a broken case to a tiny example I can debug.", relevance: { "properties-1": 2, "properties-2": 3, "properties-3": 3, "properties-7": 2 }, rationale: "Generated invariants, shrinking, and replay address the intent; snapshots, timing, and static types cover different evidence." },
  { id: "properties-paraphrase", kind: "paraphrase", query: "Check that every generated sort keeps all original elements and returns them in order.", relevance: { "properties-1": 3, "properties-2": 2, "properties-3": 2, "properties-6": 1, "properties-8": 1 }, rationale: "The sorting invariants are direct; a benchmark and type checker are only cautions about insufficient evidence." },
  { id: "properties-literal", kind: "lexical", query: '"Property-based testing"', relevance: { "properties-3": 3 }, rationale: "The named testing approach appears only in this record." },
  { id: "properties-handle", kind: "exact", query: "@fixture_properties_1", relevance: { "properties-1": 3 }, rationale: "Only this document has the requested invented author." },

  { id: "freezer-concept", kind: "conceptual", query: "Prepare legumes once so a single quick dinner is easy to retrieve later.", relevance: { "freezer-1": 3, "freezer-2": 3, "freezer-3": 2, "freezer-4": 1, "freezer-6": 1 }, rationale: "Cooked, labeled meal portions fit the intent; dry storage and one large frozen slab are partial contrasts." },
  { id: "freezer-paraphrase", kind: "paraphrase", query: "Divide cooked beans into small dated packets instead of one big frozen block.", relevance: { "freezer-1": 3, "freezer-2": 3, "freezer-3": 2, "freezer-6": 1 }, rationale: "Small portions and dates answer directly; the large casserole warns about the opposite storage choice." },
  { id: "freezer-literal", kind: "lexical", query: '"Batch cooking"', relevance: { "freezer-3": 3 }, rationale: "The literal phrase is present only in this post." },
  { id: "freezer-phrase", kind: "exact", query: '"freeze flat meal-sized portions"', relevance: { "freezer-1": 3 }, rationale: "Only the first cooking post contains the exact phrase." },

  { id: "soil-concept", kind: "conceptual", query: "How do I avoid drowning an indoor herb by following the same daily watering routine?", relevance: { "soil-1": 3, "soil-2": 3, "soil-3": 3, "soil-4": 1, "soil-5": 2, "soil-7": 1 }, rationale: "Checking actual root-zone moisture beats a blind schedule; symptoms and outdoor rain readings are partial cautions." },
  { id: "soil-paraphrase", kind: "paraphrase", query: "Feel below the surface and lift the container before deciding whether the plant needs a drink.", relevance: { "soil-1": 3, "soil-2": 3, "soil-3": 2 }, rationale: "Both pot weight and soil dryness appear in the first two; the third explains why conditions vary." },
  { id: "soil-literal", kind: "lexical", query: '"Soil moisture checks"', relevance: { "soil-3": 3 }, rationale: "Only this post contains the exact phrase." },
  { id: "soil-id", kind: "exact", query: "9900000000000000129", relevance: { "soil-1": 3 }, rationale: "The synthetic identity selects the first herb-watering post." },

  { id: "packing-concept", kind: "conceptual", query: "Keep tomorrow's clothes dry even if my backpack gets soaked on a walk.", relevance: { "packing-1": 3, "packing-2": 3, "packing-3": 2, "packing-4": 1, "packing-6": 1 }, rationale: "Sealed inner protection preserves dry essentials; jackets and mesh pouches are partial contrasts rather than bag protection." },
  { id: "packing-paraphrase", kind: "paraphrase", query: "Put the spare sleeping clothes inside a watertight liner before rain reaches the zippers.", relevance: { "packing-1": 3, "packing-2": 3, "packing-3": 2 }, rationale: "These describe an inner barrier for essentials; lighter baggage or a forecast does not seal a bag." },
  { id: "packing-literal", kind: "lexical", query: '"Waterproof packing"', relevance: { "packing-3": 3 }, rationale: "Only this record contains the requested phrase." },
  { id: "packing-url", kind: "exact", query: "https://x.com/i/web/status/9900000000000000137", relevance: { "packing-1": 3 }, rationale: "A complete status URL identifies the first rainy-trip post." },

  { id: "learning-concept", kind: "conceptual", query: "Remember ideas over several weeks instead of merely recognizing a highlighted page tonight.", relevance: { "learning-1": 3, "learning-2": 3, "learning-3": 3, "learning-4": 1, "learning-6": 1, "learning-8": 1 }, rationale: "Delayed unaided recall addresses retention; familiarity, cramming, and source navigation are partial contrasts." },
  { id: "learning-paraphrase", kind: "paraphrase", query: "Shut the textbook, explain from memory, then quiz yourself again after a gap.", relevance: { "learning-1": 3, "learning-2": 3, "learning-3": 3, "learning-8": 1 }, rationale: "These combine active recall with delay; the open-book comparison is partial and search-engine retrieval is another sense." },
  { id: "learning-literal", kind: "lexical", query: '"Spaced retrieval"', relevance: { "learning-3": 3 }, rationale: "The exact named practice occurs only in this record." },
  { id: "learning-handle", kind: "exact", query: "@fixture_learning_1", relevance: { "learning-1": 3 }, rationale: "The unique synthetic handle selects one learning post." },

  { id: "revision-concept", kind: "conceptual", query: "Find out where my explanation loses someone who does not already know the subject.", relevance: { "revision-1": 3, "revision-2": 3, "revision-3": 2, "revision-4": 1, "revision-6": 1, "revision-7": 2, "revision-8": 1 }, rationale: "A reader's observed understanding reveals gaps; spelling, vague praise, and polish only show what evidence is insufficient." },
  { id: "revision-paraphrase", kind: "paraphrase", query: "Ask a fresh reader to say back the argument before telling them what I intended.", relevance: { "revision-1": 3, "revision-2": 3, "revision-3": 2, "revision-7": 2 }, rationale: "Independent paraphrase and pinpointed misunderstanding match; software revision labels are unrelated." },
  { id: "revision-literal", kind: "lexical", query: '"Reader feedback"', relevance: { "revision-3": 3 }, rationale: "The exact phrase appears in this post only." },
  { id: "revision-phrase", kind: "exact", query: '"a reader who lacks the background"', relevance: { "revision-1": 3 }, rationale: "The contiguous wording identifies the first writing post." },

  { id: "quoted-seedlings", kind: "conceptual", context: "quoted-text", query: "Find the quoted idea about rotating seedling trays so every sprout reaches the window.", relevance: { "context-quote-1": 3 }, rationale: "The rotating seedling mechanism exists only in the quoted passage; the primary response has no gardening content." },
  { id: "quoted-paper-bridge", kind: "paraphrase", context: "quoted-text", query: "The quoted demonstration folds a sheet into ridges so it holds extra coins.", relevance: { "context-quote-2": 3 }, rationale: "The folded paper bridge is described only by quoted text; the author's primary sentence does not contain the mechanism." },
  { id: "owner-workstation-note", kind: "conceptual", context: "owner-note", query: "Find my private plan to turn an old cupboard into a standing workstation.", relevance: { "context-note-1": 3 }, rationale: "Only the separate owner note describes this cupboard project; primary source text and other woodworking references do not." },
  { id: "owner-trip-tag", kind: "lexical", context: "owner-tags", query: "copper-compass", relevance: { "context-tags-1": 3 }, rationale: "This invented label appears only in owner tags, so a primary-text-only candidate intentionally lacks this evidence." },
  { id: "spanish-shared-tools", kind: "paraphrase", context: "multilingual", language: "es", query: "¿Cómo organizar herramientas compartidas para notar enseguida cuál falta?", relevance: { "language-es-1": 3 }, rationale: "The Spanish post uses drawn tool silhouettes to reveal missing shared equipment; the English workshop response does not." },
  { id: "french-night-vision", kind: "conceptual", context: "multilingual", language: "fr", query: "Comment lire une carte céleste sans perdre l'adaptation des yeux à la nuit ?", relevance: { "language-fr-1": 3 }, rationale: "The French post preserves dark adaptation with weak red light; form warning colors and general contrast cues serve different intents." },
  { id: "german-chain-care", kind: "conceptual", context: "multilingual", language: "de", query: "Was hilft gegen eine laute, schmutzige Fahrradkette?", relevance: { "language-de-1": 3 }, rationale: "The German post cleans and lubricates a noisy chain; the English frozen bicycle lock concerns a different component and failure." },
  { id: "malay-bulk-spices", kind: "lexical", context: "multilingual", language: "ms", query: '"rempah pukal"', relevance: { "language-ms-1": 3 }, rationale: "The exact Malay phrase appears in the bulk-spice container post; English freezer portions and cooking flavors do not contain it." },
];
