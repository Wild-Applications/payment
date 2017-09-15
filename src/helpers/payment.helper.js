
//imports
var jwt = require('jsonwebtoken'),
Payment = require('../models/payment.schema.js')
request = require('request');


const secretKey = process.env.STRIPE_SECRET;
const clientId = process.env.CLIENT_ID;

var stripe = require('stripe')(secretKey);


var helper = {};

helper.get = function(call, callback){
  jwt.verify(call.metadata.get('authorization')[0], process.env.JWT_SECRET, function(err, token){
    if(err){
      return callback({message:err},null);
    }

    Payment.findOne({owner:token.sub}, function(err, paymentDetails){
      if(err){return callback(err, null);}
      callback(null, {access:paymentDetails.stripe_id});
    })
  });
}


helper.connect = function(call, callback){
  jwt.verify(call.metadata.get('authorization')[0], process.env.JWT_SECRET, function(err, token){
    if(err){
      return callback({message:err},null);
    }

    request.post({
      url: "https://connect.stripe.com/oauth/token",
      form: {
        grant_type: "authorization_code",
        client_id: clientId,
        code: call.request.code,
        client_secret: secretKey
      }
    }, function(err, r, body){
      if(err){return callback(err, null)}

      body = JSON.parse(body);
      if(body.error){
        return callback({message:body.error_description}, null);
      }
      var newPayment = new Payment({owner: token.sub, stripe_id:body.stripe_user_id});
      newPayment.save(function(err, result){
        if(err){
          return callback({message:err},null);
        }
        callback(null, {access: result.stripe_id});
      });
    });

  });
}


helper.createPayment = function(call, callback){
  jwt.verify(call.metadata.get('authorization')[0], process.env.JWT_SECRET, function(err, token){
    if(err){
      console.log(err)
      return callback({message:"Something went wrong"},null);
    }

    var grpc = require("grpc");
    var premisesDescriptor = grpc.load(__dirname + '/../proto/premises.proto').premises;
    var premisesClient = new premisesDescriptor.PremisesService('service.premises:1295', grpc.credentials.createInsecure());


    premisesClient.getOwner({premisesId: call.request.premises}, function(err, result){
      if(err){return callback(err, null)}
      Payment.findOne({owner: result.ownerId}, function(err, paymentInfo){
        if(err){return callback(err, null)}

        stripe.charges.create({
          amount: call.request.subtotal,
          currency: call.request.currency,
          source: "tok_gb",
          destination: {
            amount: calcSubTotal(call.request.subtotal, false, true, true),
            account: paymentInfo.stripe_id
          }
        }).then(function(charge){
          console.log(charge);
          callback(null, {});
        }, function(err){
          callback({message:err.message},null);
        });
      });
    })
  });
}


function getConnectedAccountId(accountId){
  Payment.findOne({owner: accountId}).exec(function(err, paymentInfo){
    if(err){
      return callback({message:JSON.stringify(err)}, null);
    }

    return callback(null, formatOrder(resultOrder));
  });
}

function calcSubTotal(subTotal, applyCommision, applyPercentageCharge, applyFixedCharge){
  var multiplier = 1;
  if(applyCommision){
    multiplier -= 0.1;
  }
  if(applyPercentageCharge){
    multiplier -= 0.014;
  }
  subTotal *= multiplier;
  Math.floor(subTotal);
  if(applyFixedCharge){
    subTotal -= 20;
  }
  return Math.ceil(subTotal);
}
module.exports = helper;
