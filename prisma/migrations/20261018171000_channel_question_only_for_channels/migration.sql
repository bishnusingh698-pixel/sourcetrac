-- New surveys took their first single-choice question as the "channel"
-- question, and the Channel report and the Dashboard's attribution numbers count
-- every survey's channel question. A template's gift, price or delivery question
-- therefore showed up there as marketing channels ("For me", "A gift").
--
-- Surveys made from a template keep a channel question only when it is the
-- template's own "Where did you first hear about us?" (Channel Compass). The
-- list below is every other question the templates ship, by stable id; a
-- question the merchant added themselves (no templateKey) is left alone, and
-- the editor now has a checkbox for it.
UPDATE "Survey" s
SET "channelReportQuestionId" = NULL
FROM "Question" q
WHERE q.id = s."channelReportQuestionId"
  AND q."templateKey" IN (
  'ad_recall_q_ads',
  'after_delivery_q_better',
  'after_delivery_q_condition',
  'after_delivery_q_like',
  'age_range_q_age',
  'almost_left_q_blocker',
  'almost_left_q_easier',
  'brand_presence_q_seen',
  'business_buyer_q_bulk_price',
  'business_buyer_q_buying_for',
  'channel_compass_q_creator',
  'channel_compass_q_when',
  'come_back_reasons_q_reason',
  'contact_preference_q_channels',
  'customer_satisfaction_q_better',
  'customer_satisfaction_q_csat',
  'deciding_detail_q_helped',
  'deciding_detail_q_missing',
  'delivery_promise_q_expectation',
  'delivery_promise_q_needs_date',
  'delivery_ready_q_availability',
  'delivery_ready_q_delivery_time',
  'delivery_ready_q_pay_online',
  'first_order_pulse_q_again',
  'first_order_pulse_q_ease',
  'first_order_pulse_q_obstacle',
  'fit_confidence_q_fit_sure',
  'fit_confidence_q_unsure_about',
  'gift_radar_q_occasion',
  'gift_radar_q_occasion_time',
  'gift_radar_q_recipient',
  'loyalty_pulse_q_fix',
  'loyalty_pulse_q_love',
  'loyalty_pulse_q_nps',
  'missing_piece_q_looked',
  'missing_piece_q_what',
  'nudge_counter_q_nudges',
  'nudge_counter_q_where',
  'offer_impact_q_offer',
  'offer_impact_q_offer_where',
  'open_feedback_q_anything',
  'packaging_priorities_q_packaging',
  'price_pulse_q_price',
  'price_pulse_q_worth',
  'product_discovery_q_easy',
  'product_discovery_q_found',
  'product_fit_q_miss',
  'product_fit_q_why',
  'purchase_reason_q_detail',
  'purchase_reason_q_reason',
  'reorder_clock_q_lasts',
  'reorder_clock_q_reorder_reminder',
  'rival_check_q_brands',
  'rival_check_q_compared',
  'rival_check_q_why_us',
  'site_ease_q_hard',
  'site_ease_q_what',
  'subscribe_interest_q_subscribe',
  'switch_story_q_before',
  'switch_story_q_brand',
  'switch_story_q_reason',
  'taste_profile_q_hear_about',
  'taste_profile_q_profile',
  'today_trigger_q_ad_where',
  'today_trigger_q_today',
  'trust_trigger_q_trust',
  'where_else_q_where'
  );
