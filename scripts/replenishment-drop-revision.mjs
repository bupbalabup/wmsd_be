// 22/11/2026: RR review no longer has REVISE; move leftover REVISION_REQUIRED requests to REJECTED.
// Preview by default; `--apply` writes. Local MongoDB only (remote needs an explicit rollout).
import mongoose from 'mongoose';
import {LOCAL_DEMO_URI,requireLoopbackMongoUri} from '../src/config/local-mongo.js';

const uri=process.env.MONGODB_URI||LOCAL_DEMO_URI;
requireLoopbackMongoUri(uri);
const client=new mongoose.mongo.MongoClient(uri,{serverSelectionTimeoutMS:10000});
try{
  await client.connect();
  const requests=client.db().collection('replenishment_requests');
  const filter={workflowStatus:'REVISION_REQUIRED'};
  const found=await requests.countDocuments(filter);
  // Version bump makes stale edit/submit clients fail their expectedVersion check.
  const result=process.argv.includes('--apply')&&found
    ?await requests.updateMany(filter,{$set:{workflowStatus:'REJECTED',updatedAt:new Date()},$inc:{version:1}})
    :null;
  const remaining=await requests.countDocuments(filter);
  console.log(JSON.stringify({database:client.db().databaseName,found,modified:result?.modifiedCount??0,remaining},null,2));
}finally{await client.close();}
