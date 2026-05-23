// Poll GitHub for open PRs that need a bot review.
// Returns { wakeAgent: bool, data: { prs: [...] } }
//
// Configure:
//   repos    - list of "owner/repo" strings to watch
//   botLogin - your GitHub App's bot identity (e.g. "my-review-bot[bot]")

const repos = [
  'owner/repo-1',
  'owner/repo-2',
];
const botLogin = 'my-review-bot[bot]';

const results = [];

for (const repo of repos) {
  try {
    const prsRes = await fetch(`https://api.github.com/repos/${repo}/pulls?state=open&per_page=50`);
    if (!prsRes.ok) continue;
    const prs = await prsRes.json();
    if (!Array.isArray(prs)) continue;

    for (const pr of prs) {
      try {
        const reviewsRes = await fetch(`https://api.github.com/repos/${repo}/pulls/${pr.number}/reviews`);
        if (!reviewsRes.ok) continue;
        const reviews = await reviewsRes.json();

        const botReviews = Array.isArray(reviews)
          ? reviews.filter(r => r.user && r.user.login === botLogin)
          : [];

        if (botReviews.length === 0) {
          // Never reviewed — include
          results.push({ repo, number: pr.number, title: pr.title, url: pr.html_url });
        } else {
          // Reviewed before — re-include only if new commits pushed since last review
          const lastBotReview = botReviews[botReviews.length - 1];
          if (lastBotReview.commit_id !== pr.head.sha) {
            results.push({ repo, number: pr.number, title: pr.title, url: pr.html_url });
          }
        }
      } catch (_) {}
    }
  } catch (_) {}
}

console.log(JSON.stringify({ wakeAgent: results.length > 0, data: { prs: results } }));
