export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const clientId = process.env.DOMO_CLIENT_ID;
  const clientSecret = process.env.DOMO_CLIENT_SECRET;
  if (!clientId || !clientSecret) return res.status(500).json({ error: 'Domo credentials not configured' });

  try {
    // Step 1: OAuth2 token exchange
    const tokenResp = await fetch(
      'https://api.domo.com/oauth/token?grant_type=client_credentials&scope=data',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64')
        }
      }
    );
    if (!tokenResp.ok) {
      const err = await tokenResp.text();
      return res.status(502).json({ error: 'Domo auth failed', detail: err });
    }
    const { access_token } = await tokenResp.json();

    // Step 2: Query dataset for today's snapshot
    const datasetId = 'e616d17f-be36-494d-8b31-f45a0850dbd8';
    const sql = `SELECT community_name, Unit_Number, care_level_mapped, unit_type_mapped, attr_floorplan, sq_ft, weighted_avg_occupancy, unit_type_rate, in_place_base_rent, in_place_package, total_in_place_rent, is_occupied FROM table WHERE report_date = CURRENT_DATE`;

    const queryResp = await fetch(
      `https://api.domo.com/v1/datasets/query/execute/${datasetId}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `bearer ${access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ sql })
      }
    );
    if (!queryResp.ok) {
      const err = await queryResp.text();
      return res.status(502).json({ error: 'Domo query failed', detail: err });
    }
    const data = await queryResp.json();

    // Step 3: Transform rows into the three arrays the app expects
    const il = [], mc = [], cs = [];

    (data.rows || []).forEach(function(row) {
      var community    = row[0];
      var unit         = row[1];
      var care         = row[2];
      var type         = row[3]  || '';
      var floorplan    = row[4]  || '';
      var sqft         = row[5]  || 0;
      var wtd          = row[6]  != null ? row[6] : 0;
      var base         = row[7]  != null ? row[7] : 0;
      var inPlaceRent  = row[8]  != null ? row[8] : 0;
      var inPlacePkg   = row[9]  != null ? row[9] : 0;
      var inPlaceTotal = row[10] != null ? row[10] : 0;
      var occupied     = row[11] != null ? row[11] : 0;

      if (care === 'IL' || care === 'AL' || care === 'Flex') {
        il.push({ community:community, unit:unit, care:care, type:type, floorplan:floorplan, sqft:sqft, wtd:wtd, base:base, inPlaceRent:inPlaceRent, inPlacePackage:inPlacePkg, inPlaceTotal:inPlaceTotal, occupied:occupied });
      } else if (care === 'MC') {
        mc.push({ community:community, unit:unit, type:type, floorplan:floorplan, sqft:sqft, wtd:wtd, base:base, inPlaceRent:inPlaceRent, inPlacePackage:inPlacePkg, inPlaceTotal:inPlaceTotal, occupied:occupied });
      } else if (care === 'CS') {
        cs.push({ community:community, unit:unit, type:type, floorplan:floorplan, sqft:sqft, wtd:wtd, base:base, inPlaceRent:inPlaceRent, inPlacePackage:inPlacePkg, inPlaceTotal:inPlaceTotal, occupied:occupied });
      }
      // Guest units are excluded from pricing
    });

    // Cache for 1 hour at CDN edge, serve stale while revalidating
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
    res.json({ il: il, mc: mc, cs: cs, updated: new Date().toISOString(), unitCount: il.length + mc.length + cs.length });

  } catch (err) {
    console.error('Domo API error:', err);
    res.status(500).json({ error: 'Internal error fetching pricing data' });
  }
}
