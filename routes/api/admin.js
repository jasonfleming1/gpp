const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// GET /api/admin/collections - List all collections with document counts
router.get('/collections', async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const collections = await db.listCollections().toArray();

    // Get document count for each collection
    const collectionStats = await Promise.all(
      collections.map(async (col) => {
        const count = await db.collection(col.name).countDocuments();
        return {
          name: col.name,
          count,
          type: col.type
        };
      })
    );

    // Sort by name
    collectionStats.sort((a, b) => a.name.localeCompare(b.name));

    res.json(collectionStats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/export/:collection - Export all documents from a collection as JSON
router.get('/export/:collection', async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const collectionName = req.params.collection;
    const includeAttachments = req.query.includeAttachments === 'true';

    // Check if collection exists
    const collections = await db.listCollections({ name: collectionName }).toArray();
    if (collections.length === 0) {
      return res.status(404).json({ error: 'Collection not found' });
    }

    // Get all documents
    let documents = await db.collection(collectionName).find({}).toArray();

    // If including attachments, embed file data as base64
    if (includeAttachments) {
      // Determine upload directory based on collection
      let uploadDir = null;
      if (collectionName === 'managertasks') {
        uploadDir = path.join(__dirname, '../../uploads/managertasks');
      } else if (collectionName === 'releases') {
        uploadDir = path.join(__dirname, '../../uploads/releases');
      }

      if (uploadDir && fs.existsSync(uploadDir)) {
        documents = documents.map(doc => {
          if (doc.attachments && Array.isArray(doc.attachments)) {
            doc.attachments = doc.attachments.map(att => {
              const filePath = path.join(uploadDir, att.filename);
              if (fs.existsSync(filePath)) {
                try {
                  const fileBuffer = fs.readFileSync(filePath);
                  att.fileData = fileBuffer.toString('base64');
                } catch (e) {
                  console.error(`Failed to read file ${att.filename}:`, e.message);
                }
              }
              return att;
            });
          }
          return doc;
        });
      }
    }

    // Set headers for file download
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${collectionName}_export_${Date.now()}.json"`);

    res.json({
      collection: collectionName,
      exportedAt: new Date().toISOString(),
      count: documents.length,
      includesAttachments: includeAttachments,
      documents
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/admin/import/:collection - Import JSON data into a collection
router.post('/import/:collection', express.json({ limit: '100mb' }), async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const collectionName = req.params.collection;
    const { documents, clearExisting } = req.body;

    if (!documents || !Array.isArray(documents)) {
      return res.status(400).json({ error: 'Invalid data format. Expected { documents: [...] }' });
    }

    if (documents.length === 0) {
      return res.status(400).json({ error: 'No documents to import' });
    }

    const collection = db.collection(collectionName);

    // Determine upload directory for attachments
    let uploadDir = null;
    if (collectionName === 'managertasks') {
      uploadDir = path.join(__dirname, '../../uploads/managertasks');
    } else if (collectionName === 'releases') {
      uploadDir = path.join(__dirname, '../../uploads/releases');
    }

    // Create upload directory if it doesn't exist
    if (uploadDir && !fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // Optionally clear existing data
    let deletedCount = 0;
    if (clearExisting) {
      const deleteResult = await collection.deleteMany({});
      deletedCount = deleteResult.deletedCount;
    }

    // Process documents and handle attachments
    const preserveIds = req.body.preserveIds === true;
    let filesWritten = 0;

    const docsToInsert = documents.map(doc => {
      // Handle attachment file data
      if (uploadDir && doc.attachments && Array.isArray(doc.attachments)) {
        doc.attachments = doc.attachments.map(att => {
          if (att.fileData) {
            try {
              // Write base64 file data to disk
              const fileBuffer = Buffer.from(att.fileData, 'base64');
              const filePath = path.join(uploadDir, att.filename);
              fs.writeFileSync(filePath, fileBuffer);
              filesWritten++;
            } catch (e) {
              console.error(`Failed to write file ${att.filename}:`, e.message);
            }
            // Remove fileData from document (don't store in DB)
            delete att.fileData;
          }
          return att;
        });
      }

      // Handle _id field
      if (!preserveIds && doc._id) {
        const { _id, ...rest } = doc;
        return rest;
      }
      // Convert string _id to ObjectId if preserving
      if (preserveIds && doc._id && typeof doc._id === 'string') {
        try {
          doc._id = new mongoose.Types.ObjectId(doc._id);
        } catch (e) {
          // If it's not a valid ObjectId string, remove it
          delete doc._id;
        }
      }
      return doc;
    });

    // Insert documents
    const result = await collection.insertMany(docsToInsert, { ordered: false });

    res.json({
      success: true,
      message: `Imported ${result.insertedCount} documents into ${collectionName}` +
               (filesWritten > 0 ? ` (${filesWritten} attachment files restored)` : ''),
      insertedCount: result.insertedCount,
      deletedCount,
      filesWritten
    });
  } catch (error) {
    // Handle duplicate key errors gracefully
    if (error.code === 11000) {
      res.status(400).json({
        error: 'Duplicate key error. Some documents may have conflicting IDs.',
        details: error.message
      });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// DELETE /api/admin/collections/:collection - Delete all documents in a collection
router.delete('/collections/:collection', async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const collectionName = req.params.collection;

    // Check if collection exists
    const collections = await db.listCollections({ name: collectionName }).toArray();
    if (collections.length === 0) {
      return res.status(404).json({ error: 'Collection not found' });
    }

    const result = await db.collection(collectionName).deleteMany({});

    res.json({
      success: true,
      message: `Deleted ${result.deletedCount} documents from ${collectionName}`,
      deletedCount: result.deletedCount
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/stats - Get database statistics
router.get('/stats', async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const stats = await db.stats();

    res.json({
      database: stats.db,
      collections: stats.collections,
      documents: stats.objects,
      dataSize: stats.dataSize,
      storageSize: stats.storageSize,
      indexes: stats.indexes,
      indexSize: stats.indexSize
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
