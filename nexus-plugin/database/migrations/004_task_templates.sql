-- Migration 004: Task Templates
-- Pre-built task templates for each integration service.
-- Populated from DB instead of hardcoded empty arrays.

BEGIN;

-- ============================================================================
-- Table: trigger.task_templates
-- Reusable task templates associated with integration services
-- ============================================================================
CREATE TABLE IF NOT EXISTS trigger.task_templates (
    template_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_name VARCHAR(100) NOT NULL CHECK (service_name IN (
        'graphrag', 'mageagent', 'fileprocess', 'learningagent',
        'geoagent', 'jupyter', 'cvat', 'gpu-bridge', 'sandbox', 'n8n'
    )),
    name VARCHAR(200) NOT NULL,
    description TEXT,
    task_identifier VARCHAR(200) NOT NULL,
    default_payload JSONB DEFAULT '{}',
    schema JSONB DEFAULT '{}',
    enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- INDEXES
-- ============================================================================
CREATE INDEX idx_task_templates_service ON trigger.task_templates(service_name);
CREATE INDEX idx_task_templates_enabled ON trigger.task_templates(enabled) WHERE enabled = TRUE;
CREATE INDEX idx_task_templates_identifier ON trigger.task_templates(task_identifier);

-- ============================================================================
-- SEED DATA: Real task templates based on actual integration client methods
-- ============================================================================

-- GraphRAG templates
INSERT INTO trigger.task_templates (service_name, name, description, task_identifier, default_payload) VALUES
('graphrag', 'Search Knowledge Graph', 'Semantic search across the knowledge graph with configurable result count', 'graphrag-search', '{"query": "", "limit": 10}'),
('graphrag', 'Ingest Document', 'Store a document in the knowledge graph for retrieval', 'graphrag-ingest-document', '{"content": "", "metadata": {}}'),
('graphrag', 'Ingest URL', 'Crawl and ingest URL content into the knowledge graph', 'graphrag-ingest-url', '{"url": ""}'),
('graphrag', 'Nightly Memory Sync', 'Iterates all organizations and syncs graph memory, prunes stale nodes', 'graphrag-nightly-memory-sync', '{"pruneOlderThanDays": 90}');

-- MageAgent templates
INSERT INTO trigger.task_templates (service_name, name, description, task_identifier, default_payload) VALUES
('mageagent', 'Process Task', 'AI agent task processing with model selection', 'mageagent-process', '{"prompt": "", "model": "default"}'),
('mageagent', 'Multi-Agent Orchestration', 'Orchestrate multiple AI agents with failover chain', 'mageagent-orchestrate', '{"agents": [], "strategy": "sequential"}'),
('mageagent', 'Vision Extract', 'Extract text and data from images using vision models', 'mageagent-vision-extract', '{"imageUrl": "", "analysisType": "general"}'),
('mageagent', 'Embedding Generation', 'Generate embeddings for text with configurable batch size', 'mageagent-embedding', '{"texts": [], "batchSize": 100}');

-- FileProcess templates
INSERT INTO trigger.task_templates (service_name, name, description, task_identifier, default_payload) VALUES
('fileprocess', 'Document Processing Pipeline', 'Sequential multi-operation document processing (OCR, tables, classify)', 'fileprocess-document-pipeline', '{"fileUrl": "", "operations": ["ocr", "tables"]}'),
('fileprocess', 'Batch OCR', 'Process multiple files through OCR in batch', 'fileprocess-batch-ocr', '{"fileUrls": []}'),
('fileprocess', 'Extract Tables', 'Extract structured tables from documents', 'fileprocess-table-extraction', '{"fileUrl": "", "format": "json"}');

-- LearningAgent templates
INSERT INTO trigger.task_templates (service_name, name, description, task_identifier, default_payload) VALUES
('learningagent', 'Discovery Search', 'Multi-source knowledge discovery with configurable depth', 'learningagent-discovery-search', '{"query": "", "depth": "medium", "sources": []}'),
('learningagent', 'Knowledge Synthesis', 'Synthesize knowledge from documents with gap analysis', 'learningagent-knowledge-synthesis', '{"documents": [], "type": "summary"}'),
('learningagent', 'Learning Pipeline', 'Sequential learning pipeline with discover/learn/synthesize steps', 'learningagent-learning-pipeline', '{"topic": "", "steps": ["discover", "learn", "synthesize"]}');

-- GeoAgent templates
INSERT INTO trigger.task_templates (service_name, name, description, task_identifier, default_payload) VALUES
('geoagent', 'Earth Engine Analysis', 'Geospatial analysis using Google Earth Engine', 'geoagent-earth-engine-analysis', '{"region": {}, "analysisType": "ndvi", "dateRange": {}}'),
('geoagent', 'BigQuery GIS', 'Execute BigQuery GIS queries with spatial data', 'geoagent-bigquery-gis', '{"query": "", "outputFormat": "geojson"}'),
('geoagent', 'Satellite Monitoring', 'Daily change detection across configured monitoring regions', 'geoagent-scheduled-monitoring', '{"regions": [], "alertThreshold": 0.1}');

-- Jupyter templates
INSERT INTO trigger.task_templates (service_name, name, description, task_identifier, default_payload) VALUES
('jupyter', 'Execute Notebook', 'Execute a Jupyter notebook with parameter injection', 'jupyter-execute-notebook', '{"notebookPath": "", "parameters": {}}'),
('jupyter', 'Create Notebook', 'Create a new Jupyter notebook with initial cells', 'jupyter-create-notebook', '{"name": "", "cells": []}'),
('jupyter', 'Notebook to Report', 'Execute and convert notebook to HTML/PDF report', 'jupyter-notebook-to-report', '{"notebookPath": "", "format": "html"}');

-- CVAT templates
INSERT INTO trigger.task_templates (service_name, name, description, task_identifier, default_payload) VALUES
('cvat', 'Create Annotation Task', 'Create a CVAT annotation task with images and labels', 'cvat-create-annotation-job', '{"name": "", "images": [], "labels": []}'),
('cvat', 'Export Dataset', 'Export annotated dataset in various formats', 'cvat-export-annotations', '{"taskId": "", "format": "COCO"}'),
('cvat', 'Auto-Annotate', 'Run auto-annotation with ML models on a task', 'cvat-auto-annotation', '{"taskId": "", "modelName": ""}');

-- GPU Bridge templates
INSERT INTO trigger.task_templates (service_name, name, description, task_identifier, default_payload) VALUES
('gpu-bridge', 'ML Training Job', 'Submit a long-running ML training job with GPU allocation', 'gpu-ml-training', '{"modelConfig": {}, "datasetPath": "", "epochs": 10}'),
('gpu-bridge', 'Batch Inference', 'Run batch inference across a dataset with GPU acceleration', 'gpu-batch-inference', '{"modelId": "", "inputs": [], "batchSize": 32}'),
('gpu-bridge', 'Model Optimization', 'Quantize, prune, or export model to ONNX', 'gpu-model-optimization', '{"modelId": "", "operation": "quantize"}');

-- Sandbox templates
INSERT INTO trigger.task_templates (service_name, name, description, task_identifier, default_payload) VALUES
('sandbox', 'Execute Code', 'Execute code in an isolated sandbox environment', 'sandbox-code-execution', '{"language": "python", "code": "", "timeout": 30}'),
('sandbox', 'Security Scan', 'Run security scan on code with severity filtering', 'sandbox-security-scan', '{"code": "", "language": "python", "severityThreshold": "medium"}'),
('sandbox', 'Test Execution', 'Run test suite in sandbox with coverage reporting', 'sandbox-test-execution', '{"source": "", "framework": "pytest", "coverageThreshold": 80}');

-- N8N templates
INSERT INTO trigger.task_templates (service_name, name, description, task_identifier, default_payload) VALUES
('n8n', 'Trigger Workflow', 'Trigger an n8n workflow by ID with optional wait for completion', 'n8n-trigger-workflow', '{"workflowId": "", "data": {}, "waitForCompletion": false}'),
('n8n', 'Workflow Chain', 'Execute multiple n8n workflows in sequence or parallel', 'n8n-workflow-chain', '{"workflows": [], "mode": "sequential"}'),
('n8n', 'Scheduled Workflow Sync', 'Sync workflow states between Trigger.dev and n8n', 'n8n-scheduled-workflow-sync', '{}');

COMMIT;
