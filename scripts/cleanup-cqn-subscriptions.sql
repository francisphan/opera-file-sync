-- =====================================================================
-- CQN Subscription Cleanup Script (SQL)
-- =====================================================================
-- Run this as the OPERA user or as DBA to clean up orphaned CQN subscriptions
-- that are consuming RAM on the Oracle server.
--
-- PREREQUISITE: Stop the opera-db-sync service before running this!
-- =====================================================================

SET SERVEROUTPUT ON;
SET LINESIZE 200;

PROMPT
PROMPT ======================================================================
PROMPT CQN Subscription Cleanup
PROMPT ======================================================================
PROMPT

-- Step 1: Check current subscriptions
PROMPT Step 1: Checking for existing CQN subscriptions...
PROMPT

SELECT SUBSCRIPTION_NAME, STATUS,
       TO_CHAR(CREATED, 'YYYY-MM-DD HH24:MI:SS') as CREATED_TIME,
       SUBSCRIPTION_TYPE
FROM USER_SUBSCR_REGISTRATIONS
ORDER BY CREATED;

PROMPT
PROMPT Step 2: Counting subscriptions...

SELECT COUNT(*) as "Total Subscriptions"
FROM USER_SUBSCR_REGISTRATIONS;

PROMPT
PROMPT Step 3: Estimating RAM usage...

SELECT
  COUNT(*) as "Email Records Being Tracked",
  ROUND(COUNT(*) * 0.5 / 1024, 2) || ' MB' as "RAM per Subscription (estimated)",
  (SELECT COUNT(*) FROM USER_SUBSCR_REGISTRATIONS) as "Number of Subscriptions",
  ROUND((COUNT(*) * 0.5 / 1024) * (SELECT COUNT(*) FROM USER_SUBSCR_REGISTRATIONS), 2) || ' MB' as "Total RAM Used (estimated)"
FROM OPERA.NAME_PHONE
WHERE PHONE_ROLE = 'EMAIL';

PROMPT
PROMPT ======================================================================
PROMPT Step 4: Removing subscriptions...
PROMPT ======================================================================
PROMPT
PROMPT This will unregister ALL CQN subscriptions for this user.
PROMPT Press Ctrl+C to cancel, or press Enter to continue...
PAUSE

-- PL/SQL block to remove all subscriptions
DECLARE
  v_count NUMBER := 0;
  v_failed NUMBER := 0;
BEGIN
  FOR sub IN (SELECT SUBSCRIPTION_NAME FROM USER_SUBSCR_REGISTRATIONS) LOOP
    BEGIN
      DBMS_OUTPUT.PUT_LINE('Removing: ' || sub.SUBSCRIPTION_NAME);

      -- Unregister the subscription
      -- Note: The subscription name must match what was used in subscribe()
      EXECUTE IMMEDIATE 'BEGIN DBMS_AQADM.UNREGISTER_SUBSCRIPTION(''' || sub.SUBSCRIPTION_NAME || '''); END;';

      DBMS_OUTPUT.PUT_LINE('  ✓ Removed successfully');
      v_count := v_count + 1;

    EXCEPTION
      WHEN OTHERS THEN
        DBMS_OUTPUT.PUT_LINE('  ✗ Failed: ' || SQLERRM);
        v_failed := v_failed + 1;
    END;
  END LOOP;

  DBMS_OUTPUT.PUT_LINE(' ');
  DBMS_OUTPUT.PUT_LINE('======================================================================');
  DBMS_OUTPUT.PUT_LINE('CLEANUP SUMMARY');
  DBMS_OUTPUT.PUT_LINE('======================================================================');
  DBMS_OUTPUT.PUT_LINE('Successfully removed: ' || v_count);
  DBMS_OUTPUT.PUT_LINE('Failed to remove: ' || v_failed);
  DBMS_OUTPUT.PUT_LINE('======================================================================');

  IF v_count > 0 THEN
    DBMS_OUTPUT.PUT_LINE(' ');
    DBMS_OUTPUT.PUT_LINE('✓ Oracle RAM should be freed immediately');
    DBMS_OUTPUT.PUT_LINE('  Check Task Manager to confirm RAM reduction');
  END IF;
END;
/

PROMPT
PROMPT Step 5: Verifying cleanup...
PROMPT

SELECT COUNT(*) as "Remaining Subscriptions"
FROM USER_SUBSCR_REGISTRATIONS;

PROMPT
PROMPT If count = 0, cleanup was successful!
PROMPT
PROMPT ======================================================================
PROMPT Next Steps:
PROMPT ======================================================================
PROMPT 1. Monitor Opera server RAM usage (should drop now)
PROMPT 2. Deploy updated opera-db-sync.exe with RAM optimizations
PROMPT 3. Restart the opera-db-sync service
PROMPT ======================================================================
PROMPT

-- Optional: For DBA to check all subscriptions across all users
-- Uncomment if you have DBA privileges:
/*
PROMPT
PROMPT DBA View: All CQN subscriptions in database
PROMPT

SELECT USERNAME, SUBSCRIPTION_NAME, STATUS, CREATED
FROM DBA_SUBSCR_REGISTRATIONS
ORDER BY USERNAME, CREATED;
*/
