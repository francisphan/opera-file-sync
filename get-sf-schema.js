#!/usr/bin/env node

/**
 * Salesforce Schema Discovery Tool
 * Queries the Salesforce API to discover the schema of the TVRS_Guest__c custom object
 */

require('dotenv').config();
const jsforce = require('jsforce');

const CONFIG = {
  salesforce: {
    instanceUrl: process.env.SF_INSTANCE_URL,
    clientId: process.env.SF_CLIENT_ID,
    clientSecret: process.env.SF_CLIENT_SECRET,
    refreshToken: process.env.SF_REFRESH_TOKEN,
  }
};

async function discoverTVRSGuestSchema() {
  console.log('🔍 Discovering TVRS Guest object schema...\n');

  // Validate configuration
  const requiredVars = ['SF_INSTANCE_URL', 'SF_CLIENT_ID', 'SF_CLIENT_SECRET', 'SF_REFRESH_TOKEN'];
  const missing = requiredVars.filter(v => !process.env[v]);

  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:');
    missing.forEach(v => console.error(`   - ${v}`));
    console.error('\nPlease configure these in your .env file');
    process.exit(1);
  }

  try {
    // Connect to Salesforce using OAuth2 refresh token
    const oauth2 = new jsforce.OAuth2({
      loginUrl: 'https://login.salesforce.com',
      clientId: CONFIG.salesforce.clientId,
      clientSecret: CONFIG.salesforce.clientSecret,
      redirectUri: 'http://localhost:3000/oauth/callback'
    });

    const conn = new jsforce.Connection({
      oauth2: oauth2,
      instanceUrl: CONFIG.salesforce.instanceUrl,
      refreshToken: CONFIG.salesforce.refreshToken,
      version: '59.0'
    });

    console.log('Connecting to Salesforce...');
    // Test connection by getting identity
    await conn.identity();
    console.log('✅ Connected to Salesforce\n');

    // Describe the TVRS_Guest__c object
    console.log('Fetching TVRS_Guest__c object metadata...');
    const metadata = await conn.sobject('TVRS_Guest__c').describe();

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('TVRS GUEST OBJECT SCHEMA');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log(`Object Label: ${metadata.label}`);
    console.log(`API Name: ${metadata.name}`);
    console.log(`Total Fields: ${metadata.fields.length}\n`);

    // Group fields by type
    const standardFields = [];
    const customFields = [];
    const systemFields = [];

    metadata.fields.forEach(field => {
      if (field.name.endsWith('__c')) {
        customFields.push(field);
      } else if (['Id', 'Name', 'CreatedDate', 'CreatedById', 'LastModifiedDate', 'LastModifiedById', 'SystemModstamp', 'OwnerId'].includes(field.name)) {
        systemFields.push(field);
      } else {
        standardFields.push(field);
      }
    });

    // Print custom fields (most relevant for mapping)
    console.log('━━━ CUSTOM FIELDS ━━━');
    customFields.forEach(field => {
      const externalId = field.externalId ? ' [EXTERNAL ID]' : '';
      const required = field.nillable ? '' : ' [REQUIRED]';
      const unique = field.unique ? ' [UNIQUE]' : '';
      console.log(`\n${field.label}${externalId}${required}${unique}`);
      console.log(`  API Name: ${field.name}`);
      console.log(`  Type: ${field.type}${field.length ? ` (${field.length})` : ''}`);
      if (field.picklistValues && field.picklistValues.length > 0) {
        console.log(`  Picklist Values: ${field.picklistValues.map(v => v.value).join(', ')}`);
      }
    });

    console.log('\n\n━━━ STANDARD FIELDS ━━━');
    standardFields.forEach(field => {
      console.log(`\n${field.label}`);
      console.log(`  API Name: ${field.name}`);
      console.log(`  Type: ${field.type}`);
    });

    console.log('\n\n━━━ SYSTEM FIELDS ━━━');
    systemFields.forEach(field => {
      console.log(`${field.name} (${field.type})`);
    });

    // Look for potential external ID fields for email
    console.log('\n\n━━━ FIELDS SUITABLE FOR EMAIL UPSERT ━━━');
    const emailFields = metadata.fields.filter(f =>
      f.externalId ||
      f.unique ||
      f.name.toLowerCase().includes('email')
    );

    if (emailFields.length > 0) {
      emailFields.forEach(field => {
        const tags = [];
        if (field.externalId) tags.push('EXTERNAL ID');
        if (field.unique) tags.push('UNIQUE');
        console.log(`${field.name} - ${field.label} [${tags.join(', ')}]`);
      });
    } else {
      console.log('⚠️  No fields marked as External ID or Unique');
      console.log('   You may need to mark an email field as External ID in Salesforce Setup');
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Output JSON for programmatic use
    const schemaOutput = {
      objectName: metadata.name,
      objectLabel: metadata.label,
      fields: metadata.fields.map(f => ({
        name: f.name,
        label: f.label,
        type: f.type,
        length: f.length,
        required: !f.nillable,
        externalId: f.externalId,
        unique: f.unique,
        picklistValues: f.picklistValues ? f.picklistValues.map(v => v.value) : undefined,
      })),
    };

    const fs = require('fs');
    const outputPath = './tvrs-guest-schema.json';
    fs.writeFileSync(outputPath, JSON.stringify(schemaOutput, null, 2));
    console.log(`📄 Full schema saved to: ${outputPath}\n`);

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

discoverTVRSGuestSchema();
