// server.js - Node.js Express Server with Fixed Model Loading
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');

const app = express();
const PORT = 3000;

// CONFIGURE YOUR COMFYUI SETTINGS HERE
const COMFYUI_INPUT_FOLDER = 'D:/ComfyUI_windows_portable_nvidia/ComfyUI_windows_portable/ComfyUI/input';
// UPDATED: Use your specific model directory
const COMFYUI_OUTPUT_FOLDER = 'D:/ComfyUI_windows_portable_nvidia/webcam-comfyui-3D-app-main/public/models';
const MODEL_MESH_FOLDER = 'D:/ComfyUI_windows_portable_nvidia/webcam-comfyui-3D-app-main/public/models/mesh';

const COMFYUI_API_URL = 'http://127.0.0.1:8188';
const COMFYUI_WORKFLOW_FILE = './workflow.json';
const PROMPT_DELAY_SECONDS = 5;

// FIXED FILENAMES
const INPUT_FILENAME = 'webcam_input.jpg';
const OUTPUT_PREFIX = 'webcam_3d_mesh';
const MESH_FOLDER = 'mesh'; // Relative folder name

// Load ComfyUI workflow template
let workflowTemplate = {};
try {
    if (fs.existsSync(COMFYUI_WORKFLOW_FILE)) {
        workflowTemplate = JSON.parse(fs.readFileSync(COMFYUI_WORKFLOW_FILE, 'utf8'));
        console.log('✅ Workflow template loaded from:', COMFYUI_WORKFLOW_FILE);
        console.log('📄 Workflow contains', Object.keys(workflowTemplate).length, 'nodes');
    } else {
        console.log('⚠️  No workflow file found. Create workflow.json for automatic prompting.');
    }
} catch (error) {
    console.error('❌ Error loading workflow template:', error.message);
    console.log('🔧 Please check your workflow.json file for syntax errors');
}

// Ensure directories exist
console.log('🔍 Checking directories...');
const dirsToCheck = [COMFYUI_INPUT_FOLDER, COMFYUI_OUTPUT_FOLDER, MODEL_MESH_FOLDER];

dirsToCheck.forEach(dir => {
    if (!fs.existsSync(dir)) {
        try {
            fs.mkdirSync(dir, { recursive: true });
            console.log(`📁 Created directory: ${dir}`);
        } catch (error) {
            console.error(`❌ Failed to create directory ${dir}:`, error.message);
        }
    } else {
        console.log(`✅ Directory exists: ${dir}`);
    }
});

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));
app.use(express.static('./')); // Serve files from current directory

// IMPORTANT: Serve the models directory with proper CORS headers
app.use('/models', express.static(COMFYUI_OUTPUT_FOLDER, {
    setHeaders: (res, filePath) => {
        console.log(`📁 Serving file: ${filePath}`);
        // Set CORS headers for all model files
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Methods', 'GET');
        res.set('Access-Control-Allow-Headers', 'Content-Type');
        
        // Set appropriate content types
        if (filePath.endsWith('.glb')) {
            res.set('Content-Type', 'model/gltf-binary');
        } else if (filePath.endsWith('.gltf')) {
            res.set('Content-Type', 'model/gltf+json');
        }
    }
}));

// Also serve direct access to mesh folder
app.use('/mesh', express.static(MODEL_MESH_FOLDER, {
    setHeaders: (res, filePath) => {
        console.log(`📦 Serving mesh file: ${filePath}`);
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Content-Type', 'model/gltf-binary');
    }
}));

// Function to find GLB files in the mesh folder
function findGLBFiles() {
    try {
        console.log(`🔍 Scanning for GLB files in: ${MODEL_MESH_FOLDER}`);
        
        if (!fs.existsSync(MODEL_MESH_FOLDER)) {
            console.log(`❌ Mesh folder does not exist: ${MODEL_MESH_FOLDER}`);
            return [];
        }

        const files = fs.readdirSync(MODEL_MESH_FOLDER)
            .filter(file => {
                const isGLB = file.toLowerCase().endsWith('.glb');
                if (isGLB) {
                    console.log(`✅ Found GLB file: ${file}`);
                }
                return isGLB;
            })
            .map(file => {
                const fullPath = path.join(MODEL_MESH_FOLDER, file);
                const stats = fs.statSync(fullPath);
                return {
                    name: file,
                    path: fullPath,
                    url: `/mesh/${file}`, // Direct URL to mesh folder
                    size: stats.size,
                    created: stats.mtime,
                    modified: stats.mtime
                };
            })
            .sort((a, b) => b.created - a.created); // Sort by newest first

        console.log(`📊 Found ${files.length} GLB files total`);
        return files;
        
    } catch (error) {
        console.error('❌ Error scanning for GLB files:', error);
        return [];
    }
}

// Function to find the latest GLB file
function findLatestGLBFile() {
    const files = findGLBFiles();
    return files.length > 0 ? files[0] : null;
}

// Function to update workflow with image filename
function updateWorkflowWithImage(workflow, imageName) {
    const updatedWorkflow = JSON.parse(JSON.stringify(workflow)); // Deep clone
    
    // Find and update LoadImage nodes
    for (const nodeId in updatedWorkflow) {
        const node = updatedWorkflow[nodeId];
        
        // Update LoadImage node
        if (node.class_type === 'LoadImage') {
            if (node.inputs && node.inputs.image) {
                node.inputs.image = imageName;
                console.log(`Updated LoadImage node ${nodeId} with image: ${imageName}`);
            }
        }
        
        // Update SaveGLB nodes to save to our mesh folder
        if (node.class_type === 'SaveGLB') {
            if (node.inputs && node.inputs.filename_prefix) {
                // Set the output to save directly to our mesh folder
                node.inputs.filename_prefix = `${OUTPUT_PREFIX}`;
                console.log(`Updated SaveGLB node ${nodeId} with prefix: ${OUTPUT_PREFIX}`);
            }
        }
        
        // Update other image input nodes
        if (node.class_type === 'LoadImageMask' || node.class_type === 'ImageInput') {
            if (node.inputs && node.inputs.image) {
                node.inputs.image = imageName;
                console.log(`Updated ${node.class_type} node ${nodeId} with image: ${imageName}`);
            }
        }
    }
    
    return updatedWorkflow;
}

// Function to queue prompt in ComfyUI
async function queueComfyUIPrompt(workflow, filename) {
    try {
        console.log('🔍 Checking ComfyUI connection...');
        
        // Check if ComfyUI is running
        const healthCheck = await fetch(`${COMFYUI_API_URL}/system_stats`, { 
            timeout: 5000,
            headers: { 'User-Agent': 'webcam-comfyui-app' }
        });
        
        if (!healthCheck.ok) {
            throw new Error(`ComfyUI server returned status: ${healthCheck.status}`);
        }

        console.log('✅ ComfyUI is responding');

        // Update workflow with the new image
        const updatedWorkflow = updateWorkflowWithImage(workflow, filename);
        
        // Prepare prompt data
        const promptData = {
            prompt: updatedWorkflow,
            client_id: `webcam_app_${Date.now()}`
        };

        console.log('📤 Sending workflow to ComfyUI...');

        // Queue the prompt
        const response = await fetch(`${COMFYUI_API_URL}/prompt`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'webcam-comfyui-app'
            },
            body: JSON.stringify(promptData),
            timeout: 10000
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`ComfyUI API error: ${response.status} ${response.statusText} - ${errorText}`);
        }

        const result = await response.json();
        console.log('✅ ComfyUI prompt queued successfully:', result);
        
        return {
            success: true,
            prompt_id: result.prompt_id,
            number: result.number
        };

    } catch (error) {
        console.error('❌ Error queuing ComfyUI prompt:', error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

// Route to save webcam frame and queue ComfyUI workflow
app.post('/save-frame', async (req, res) => {
    try {
        console.log('📸 Received frame save request');
        
        const { imageData } = req.body;
        
        if (!imageData) {
            return res.status(400).json({ error: 'Missing imageData' });
        }

        const filename = INPUT_FILENAME;

        // Remove data:image/jpeg;base64, prefix
        const base64Data = imageData.replace(/^data:image\/jpeg;base64,/, '');
        
        // Convert base64 to buffer
        const buffer = Buffer.from(base64Data, 'base64');
        
        // Full path for the file
        const filePath = path.join(COMFYUI_INPUT_FOLDER, filename);
        
        // Write file to ComfyUI input folder
        fs.writeFileSync(filePath, buffer);
        console.log(`💾 Frame saved: ${filePath}`);
        
        // Send immediate response
        res.json({ 
            success: true, 
            message: `Frame saved to ${filePath}`,
            filename: filename,
            path: filePath,
            comfyui_enabled: Object.keys(workflowTemplate).length > 0,
            delay_seconds: PROMPT_DELAY_SECONDS,
            mesh_folder: MODEL_MESH_FOLDER
        });

        // Queue ComfyUI workflow after delay
        if (Object.keys(workflowTemplate).length > 0) {
            console.log(`⏰ Waiting ${PROMPT_DELAY_SECONDS} seconds before queuing ComfyUI workflow...`);
            
            setTimeout(async () => {
                const result = await queueComfyUIPrompt(workflowTemplate, filename);
                
                if (result.success) {
                    console.log(`🎨 ComfyUI workflow queued successfully for ${filename}`);
                    console.log(`   📋 Prompt ID: ${result.prompt_id}, Queue Number: ${result.number}`);
                    console.log(`   📁 3D Mesh will be saved to: ${MODEL_MESH_FOLDER}/${OUTPUT_PREFIX}_XXXXX.glb`);
                } else {
                    console.log(`❌ Failed to queue ComfyUI workflow: ${result.error}`);
                }
            }, PROMPT_DELAY_SECONDS * 1000);
        } else {
            console.log('⚠️  No workflow loaded, skipping ComfyUI processing');
        }
        
    } catch (error) {
        console.error('❌ Error saving frame:', error);
        res.status(500).json({ error: 'Failed to save frame' });
    }
});

// Route to get latest GLB model
app.get('/latest-model', (req, res) => {
    try {
        const latestModel = findLatestGLBFile();
        
        if (latestModel) {
            console.log(`📦 Latest model: ${latestModel.name}`);
            res.json({
                success: true,
                model: latestModel
            });
        } else {
            console.log('📭 No GLB models found');
            res.json({
                success: false,
                message: 'No GLB models found'
            });
        }
    } catch (error) {
        console.error('❌ Error getting latest model:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to check for models'
        });
    }
});

// Route to list all GLB models
app.get('/models', (req, res) => {
    try {
        const models = findGLBFiles();
        
        console.log(`📋 Listing ${models.length} models`);
        
        res.json({
            success: true,
            models: models,
            count: models.length,
            mesh_folder: MODEL_MESH_FOLDER
        });
        
    } catch (error) {
        console.error('❌ Error listing models:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to list models'
        });
    }
});

// Route to get current configuration
app.get('/config', (req, res) => {
    res.json({ 
        saveLocation: COMFYUI_INPUT_FOLDER,
        outputLocation: COMFYUI_OUTPUT_FOLDER,
        meshFolder: MODEL_MESH_FOLDER,
        comfyuiApiUrl: COMFYUI_API_URL,
        workflowLoaded: Object.keys(workflowTemplate).length > 0,
        delaySeconds: PROMPT_DELAY_SECONDS,
        inputFilename: INPUT_FILENAME,
        outputPrefix: OUTPUT_PREFIX,
        workflowType: '3D Mesh Generation (Hunyuan3D)',
        inputExists: fs.existsSync(COMFYUI_INPUT_FOLDER),
        outputExists: fs.existsSync(COMFYUI_OUTPUT_FOLDER),
        meshFolderExists: fs.existsSync(MODEL_MESH_FOLDER)
    });
});

// Route to test ComfyUI connection
app.get('/test-comfyui', async (req, res) => {
    try {
        console.log('🧪 Testing ComfyUI connection...');
        const response = await fetch(`${COMFYUI_API_URL}/system_stats`, { 
            timeout: 5000,
            headers: { 'User-Agent': 'webcam-comfyui-app' }
        });
        
        if (response.ok) {
            const stats = await response.json();
            console.log('✅ ComfyUI connection test successful');
            res.json({ 
                success: true, 
                message: 'ComfyUI is running',
                stats: stats
            });
        } else {
            console.log(`❌ ComfyUI returned status: ${response.status}`);
            res.json({ 
                success: false, 
                message: `ComfyUI returned status: ${response.status}`
            });
        }
    } catch (error) {
        console.log(`❌ Cannot connect to ComfyUI: ${error.message}`);
        res.json({ 
            success: false, 
            message: `Cannot connect to ComfyUI: ${error.message}`
        });
    }
});

// Route to debug model files and paths
app.get('/debug-models', (req, res) => {
    try {
        const debugInfo = {
            configuredPaths: {
                comfyuiOutput: COMFYUI_OUTPUT_FOLDER,
                meshFolder: MODEL_MESH_FOLDER,
                outputPrefix: OUTPUT_PREFIX
            },
            pathStatus: {
                outputExists: fs.existsSync(COMFYUI_OUTPUT_FOLDER),
                meshExists: fs.existsSync(MODEL_MESH_FOLDER)
            },
            foundFiles: []
        };

        // Check what files exist in the mesh folder
        if (fs.existsSync(MODEL_MESH_FOLDER)) {
            const allFiles = fs.readdirSync(MODEL_MESH_FOLDER);
            debugInfo.allFiles = allFiles;
            
            allFiles.forEach(file => {
                const fullPath = path.join(MODEL_MESH_FOLDER, file);
                const stats = fs.statSync(fullPath);
                debugInfo.foundFiles.push({
                    name: file,
                    fullPath: fullPath,
                    url: `/mesh/${file}`,
                    size: stats.size,
                    created: stats.mtime,
                    isGLB: file.toLowerCase().endsWith('.glb')
                });
            });
        }

        res.json(debugInfo);
    } catch (error) {
        res.status(500).json({
            error: error.message,
            stack: error.stack
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        paths: {
            input: COMFYUI_INPUT_FOLDER,
            output: COMFYUI_OUTPUT_FOLDER,
            mesh: MODEL_MESH_FOLDER
        },
        pathsExist: {
            input: fs.existsSync(COMFYUI_INPUT_FOLDER),
            output: fs.existsSync(COMFYUI_OUTPUT_FOLDER),
            mesh: fs.existsSync(MODEL_MESH_FOLDER)
        }
    });
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('🚨 Server error:', error);
    res.status(500).json({ error: 'Internal server error' });
});

// Handle process termination gracefully
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server gracefully...');
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('🚨 Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start server
app.listen(PORT, () => {
    console.log('\n🚀 ================================');
    console.log('🎥 Webcam to 3D Mesh Server Started!');
    console.log('🚀 ================================');
    console.log(`🌐 Server running at: http://localhost:${PORT}`);
    console.log(`📁 Input frames: ${COMFYUI_INPUT_FOLDER}`);
    console.log(`📁 Output models: ${COMFYUI_OUTPUT_FOLDER}`);
    console.log(`📁 Mesh folder: ${MODEL_MESH_FOLDER}`);
    console.log(`🔗 ComfyUI API URL: ${COMFYUI_API_URL}`);
    console.log(`⏰ Workflow delay: ${PROMPT_DELAY_SECONDS} seconds`);
    console.log(`📄 Input filename: ${INPUT_FILENAME}`);
    console.log(`🎨 3D Mesh output: ${OUTPUT_PREFIX}_XXXXX.glb`);
    console.log('🚀 ================================\n');
    
    // Check for existing models on startup
    const models = findGLBFiles();
    if (models.length > 0) {
        console.log(`✅ Found ${models.length} existing 3D model(s):`);
        models.forEach((model, index) => {
            console.log(`   ${index + 1}. ${model.name} (${(model.size / 1024 / 1024).toFixed(2)} MB)`);
        });
        console.log(`   🔗 Models available at: /mesh/[filename]`);
    } else {
        console.log(`📁 No existing 3D models found in: ${MODEL_MESH_FOLDER}`);
    }
    
    if (Object.keys(workflowTemplate).length === 0) {
        console.log('\n⚠️  No workflow loaded. Create workflow.json to enable automatic prompting.');
    } else {
        console.log(`\n✅ Hunyuan3D workflow template loaded (${Object.keys(workflowTemplate).length} nodes)`);
    }
    
    console.log('\n🎯 Ready for webcam captures! Open http://localhost:3000 in your browser');
    console.log(`🐛 Debug models at: http://localhost:3000/debug-models\n`);
});