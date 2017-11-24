
//imports
var jwt = require('jsonwebtoken'),
Premises = require('../models/premises.schema.js'),
Customer = require('../models/customer.schema.js'),
Payment = require('../models/payment.schema.js'),
request = require('request'),
errors = require('../errors/errors.json');


const secretKey = process.env.STRIPE_SECRET;
const clientId = process.env.CLIENT_ID;

var stripe = require('stripe')(secretKey);

var grpc = require("grpc");
var premisesDescriptor = grpc.load(__dirname + '/../proto/premises.proto').premises;
var premisesClient = new premisesDescriptor.PremisesService('service.premises:1295', grpc.credentials.createInsecure());

var helper = {};

helper.get = function(call, callback){
  jwt.verify(call.metadata.get('authorization')[0], process.env.JWT_SECRET, function(err, token){
    if(err){
      return callback({message:err},null);
    }

    Premises.findOne({owner:token.sub}, function(err, paymentDetails){
      if(err){return callback(err, null);}
      stripe.accounts.retrieve( paymentDetails.stripe_id, function(err, account){
        if(err){callback({message:JSON.stringify({message:"Unable to retrieve users stripe account", code: '0016'})},null)}
        if(account){
          var formatted = {};
          formatted.chargesEnabled = account.charges_enabled;
          formatted.payoutsEnabled = account.payouts_enabled;
          formatted.detailsSubmitted = account.details_submitted;
          formatted.displayName = account.display_name;
          formatted.currency = account.default_currency;

          callback(null, formatted);
        }else{
            return callback(null,null);
        }
      });

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
      var newPremises = new Premises({owner: token.sub, stripe_id:body.stripe_user_id});
      newPremises.save(function(err, result){
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
    console.log('save details', call.request.storePaymentDetails);
    premisesClient.getOwner({premisesId: call.request.premises}, function(err, result){

      if(err){return callback(err, null)}
      Premises.findOne({owner: result.ownerId}, function(err, paymentInfo){
        if(err){return callback(err, null)}
        Customer.findOne({owner:token.sub}, function(err, customer){
          if(err){
            return callback({message:'something went wrong retrieving customer from stripe'}, null);
          }
          if(!customer){
            var options = {};
            if(call.request.storePaymentDetails){
              options.source = call.request.source;
              stripe.customers.create(options, function(err, newCust){
                if(err){
                  return callback({message:'something went wrong when creating a stripe customer'}, null);
                }
                var newCustToStore = new Customer({owner:token.sub, customer:newCust.id});
                newCustToStore.save(function(err, storedCustomer){
                  if(err){
                    callback({message:'error when storing stripe customer object'}, null);
                  }
                  createPayment(call.request.subtotal, call.request.currency, call.request.source, paymentInfo.stripe_id, newCust.id, call.request.order, callback);
                })
              })
            }else{
              createPayment(call.request.subtotal, call.request.currency, call.request.source, paymentInfo.stripe_id, null, call.request.order, callback);
            }

          }else{
            if(call.request.storePaymentDetails){
              console.log('Adding card to user');
              stripe.customers.createSource(customer.customer, {source:call.request.source}, function(err, updatedCustomer){
                if(err){
                  console.log(err);
                  return callback({message:'something went wrong while storing payment method'}, null);
                }
                console.log(updatedCustomer.sources.data);
                createPayment(call.request.subtotal, call.request.currency, call.request.source, paymentInfo.stripe_id, customer.customer, call.request.order, callback);
              })
            }else{
              createPayment(call.request.subtotal, call.request.currency, call.request.source, paymentInfo.stripe_id, customer.customer, call.request.order, callback);
            }
          }
        })
      });
    })
  });
}

helper.capturePayment = function(call, callback){
  jwt.verify(call.metadata.get('authorization')[0], process.env.JWT_SECRET, function(err, token){
    if(err){
      console.log(err)
      return callback({message:"Something went wrong"},null);
    }
    Payment.findOne({"order": call.request.order}, function(paymentRetrievalError, payment){
      console.log(payment);
      if(paymentRetrievalError){
        return callback(paymentRetrievalError, null);
      }else if(!payment){
        return callback({message:"Unable to find payment for that order"},null);
      }else if(payment.captured){
        //payment already captured
        return callback({message: 'payment has already been captured'},null);
      }
      //update captured state
      stripe.charges.capture(payment.stripe_id).then(function(charge){
        payment.captured = true;
        payment.save(function(paymentUpdateError, paymentUpdated){
          if(paymentUpdateError){
            return callback(paymentUpdateError, null);
          }
          return callback(null, {captured: true});
        });
      }).catch(function(err){
        if(err.message.includes(payment.stripe_id)){
          if(err.message.includes('refunded')){
            //payment has been refunded;
            payment.refunded = true;
            payment.save(function(saveError){
              if(saveError){
                return callback({message:errors['0004'], name:'09000004'},null);
              }
              return callback(null, {captured: false});
            });
          }
          if(err.message.includes('captured')){
              //payment has been captured
              payment.captured = true;
              payment.save((saveError) => {
                if(saveError){
                  return callback({message:errors['0004'], name:'09000004'},null);
                }
                return callback(null, {captured: true});
              });
          }
        }
        return callback({message:err.message}, null);
      });

    });
  });
}

helper.refundPayment = function(call, callback){
  jwt.verify(call.metadata.get('authorization')[0], process.env.JWT_SECRET, function(err, token){
    if(err){
      console.log(err)
      return callback({message:"Something went wrong"},null);
      Payment.findOne({"stripe_id": call.request.order}, function(paymentRetrievalError, payment){
        if(paymentRetrievalError){
          return callback(paymentRetrievalError, null);
        }else if(payment.refunded){
          //payment already captured
          return callback({message: 'payment has already been refunded'},null);
        }
        //update captured state
        stripe.refunds.create({
            charge: payment.stripe_id,
            refund_application_fee: false
        }, function(refundError, paymentResponse){
          if(refundError){
            return callback(refundError, null);
          }
          return callback(null, {refunded: true});
        });
      });
    }
  });
}

function createPayment(subtotal, currency, source, premisesAccountId, customerId, order, callback){
  var options = {
      amount: subtotal,
      currency: currency,
      source: source,
      capture: false,
      destination: {
        amount: calcSubTotal(subtotal, true, true, true),
        account: premisesAccountId
      }
    };
    if(customerId){
      options.customer =  customerId;
    }
    console.log(options);
    stripe.charges.create(options).then(function(charge){
      //store the charge so we can capture it later
      var paymentToStore = new Payment({stripe_id: charge.id, order: order, captured: false, refunded: false});
      paymentToStore.save(function(err, saved){
        if(err){
          return callback({message:'Payment was created but was not saved on our side'}, null);
        }
        return callback(null, {});
      })
    }, function(err){
      return callback({message:err.message},null);
    });
}


helper.createSubscriptionCharge = function(call, callback){
  stripe.accounts.list(
    { limit: 5 },
    function(err, accounts) {
      consoole.log(err);
      console.log(accounts);
    }
  );
  Premises.findOne({owner: call.request._id}, function(err, paymentInfo){
    if(err){return callback(err, null)}
    var options = {
      amount: call.request.fee,
      currency: 'gbp',
      source: paymentInfo.stripe_id
    };
    stripe.charges.create(options, function(err, payment){
      if(err){
        console.log(err);
        return callback({message: "subscription wasnt processed"}, null);
      }
      //return necessary payment info
      console.log(payment);
      return callback(null, {})
    })
  });
}

helper.getStoredPaymentMethods = function(call, callback){
  jwt.verify(call.metadata.get('authorization')[0], process.env.JWT_SECRET, function(err, token){
    if(err){
      console.log(err)
      return callback({message:"Something went wrong"},null);
    }

    Customer.findOne({owner: token.sub}, function(err, customer){
      if(err){
        console.log(err);
        return callback({message:"Something went wrong when finding customer"},null);
      }
      if(customer){
        stripe.customers.retrieve(customer.customer, function(err, customerObj){
          if(err){console.log(err);return callback({message: 'something went wrong when retrieving customer from stripe'},null);}
          var paymentMethods = {};
          paymentMethods.cards = [];
          for(var i=0;i<customerObj.sources.data.length;i++){
            var paymentMethod = customerObj.sources.data[i];
            if(paymentMethod.object == 'card'){
              //card has been stored
              var cardObj = {};
              console.log(paymentMethod);
              cardObj.source = paymentMethod.id;
              cardObj.exp_month = paymentMethod.exp_month.toString();
              cardObj.exp_year = paymentMethod.exp_year.toString();
              cardObj.last4 = paymentMethod.last4;
              cardObj.brand = paymentMethod.brand;
              cardObj.fingerprint = paymentMethod.fingerprint;
              paymentMethods.cards[paymentMethods.cards.length] = cardObj;
            }
          }
          callback(null, paymentMethods);
        });
      }else{
        return callback({message:'Customer doesnt exist with stripe'}, null);
      }
    })
  });
}


helper.wasRefunded = function(call, callback){
  if(call.request.charge_id){
    Payment.findOne({stripe_id: call.request.charge_id}, (error, result) => {
      if(error){
        return callback({message:errors['0001'], name:'09000001'}, null);
      }
      result.refunded = true;
      result.save((err) => {
        if(err){
          return callback({message:errors['0003'], name: '09000003'}, null);
        }else{
          return callback(null, {order_id:result.order});
        }
      });
    });
  }else{
    return callback({message:errors['0002'], name:'09000002'}, null);
  }
}

function getConnectedAccountId(accountId){
  Premises.findOne({owner: accountId}).exec(function(err, paymentInfo){
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
