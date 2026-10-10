import type { DatabaseSync } from "node:sqlite";
import { deliveriesSince } from "./clock.ts";
import { all, get } from "./db.ts";

export type CreatorMatch = {
  id: string;
  name: string;
  niche_score: number;
  latest_reach: number;
  deliveries_90d: number;
};

export type CreatorPage = {
  campaign_id: string;
  total: number;
  creators: CreatorMatch[];
};

type CampaignRow = { niches_json: string };
type CreatorRow = { id: string; name: string; niches_json: string };
type AccountReachRow = { creator_id: string; views: number };
type DeliveryCountRow = { creator_id: string; n: number };

function compareCreators(left: CreatorMatch, right: CreatorMatch): number {
  if (right.niche_score !== left.niche_score) return right.niche_score - left.niche_score;
  if (right.latest_reach !== left.latest_reach) return right.latest_reach - left.latest_reach;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

export async function listCreators(
  db: DatabaseSync,
  input: { campaignId: string; limit: number; offset: number },
): Promise<CreatorPage | null> {
  const campaign = await get<CampaignRow>(
    db,
    "SELECT niches_json FROM campaigns WHERE id = ?",
    input.campaignId,
  );
  if (!campaign) return null;

  const campaignNiches = JSON.parse(campaign.niches_json) as string[];
  const creators = await all<CreatorRow>(db, "SELECT id, name, niches_json FROM creators");
  const scored: CreatorMatch[] = [];

  for (const creator of creators) {
    const creatorNiches = JSON.parse(creator.niches_json) as string[];
    let nicheScore = 0;
    for (const campaignNiche of campaignNiches) {
      for (const creatorNiche of creatorNiches) {
        if (campaignNiche === creatorNiche) nicheScore += 1;
      }
    }
    if (nicheScore === 0) continue;

    scored.push({
      id: creator.id,
      name: creator.name,
      niche_score: nicheScore,
      latest_reach: 0,
      deliveries_90d: 0,
    });
  }

  if (scored.length > 0) {
    // One JSON parameter avoids SQLite's bound-parameter limit for large campaigns.
    const matchingIds = JSON.stringify(scored.map((creator) => creator.id));
    const byId = new Map(scored.map((creator) => [creator.id, creator]));
    const reaches = await all<AccountReachRow>(
      db,
      `SELECT accounts.creator_id,
              COALESCE((
                SELECT metrics.views
                FROM metrics
                WHERE metrics.account_id = accounts.id
                ORDER BY metrics.captured_at DESC, metrics.id DESC
                LIMIT 1
              ), 0) AS views
       FROM social_accounts AS accounts
       WHERE accounts.creator_id IN (SELECT value FROM json_each(?))
       ORDER BY accounts.rowid`,
      matchingIds,
    );
    for (const reach of reaches) {
      const creator = byId.get(reach.creator_id);
      if (creator) creator.latest_reach += reach.views;
    }

    const deliveries = await all<DeliveryCountRow>(
      db,
      `SELECT creator_id, COUNT(*) AS n
       FROM deliveries
       WHERE creator_id IN (SELECT value FROM json_each(?))
         AND delivered_at >= ?
       GROUP BY creator_id`,
      matchingIds,
      deliveriesSince(),
    );
    for (const delivery of deliveries) {
      const creator = byId.get(delivery.creator_id);
      if (creator) creator.deliveries_90d = Number(delivery.n);
    }
  }

  scored.sort(compareCreators);
  return {
    campaign_id: input.campaignId,
    total: scored.length,
    creators: scored.slice(input.offset, input.offset + input.limit),
  };
}
