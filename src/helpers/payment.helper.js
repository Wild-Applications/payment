
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
      return callback(errors['0009'],null);
    }

    Premises.findOne({owner:token.sub}, function(err, paymentDetails){
      if(err){return callback(errors['0007'], null);}
      if(paymentDetails){
        stripe.accounts.retrieve( paymentDetails.stripe_id, function(err, account){
          if(err){
            return callback(errors['0007'],null)
          }
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
      }else{
        console.log(paymentDetails);
        return callback(null, paymentDetails);
      }
    })
  });
}


helper.connect = function(call, callback){
  jwt.verify(call.metadata.get('authorization')[0], process.env.JWT_SECRET, function(err, token){
    if(err){
      return callback(errors['0009'],null);
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
      if(err){
        return callback(errors['0010'], null)
      }

      body = JSON.parse(body);
      if(body.error){
        var error = errors['0010'];
        error.message = body.error_description;
        return callback(error, null);
      }
      var newPremises = new Premises({owner: token.sub, stripe_id:body.stripe_user_id});
      newPremises.save(function(err, result){
        if(err){
          return callback(errors['0010'],null);
        }
        callback(null, {access: result.stripe_id});
      });
    });

  });
}

helper.createPayment = function(call, callback){
  jwt.verify(call.metadata.get('authorization')[0], process.env.JWT_SECRET, function(err, token){
    if(err){
      return callback(errors['0009'],null);
    }
    console.log('request', call.request);
    premisesClient.getOwner({premisesId: call.request.premises}, function(err, result){
      if(err){return callback(err, null)}
      Premises.findOne({owner: result.ownerId}, function(err, paymentInfo){
        if(err){return callback(errors['0011'], null)}
        Customer.findOne({owner:token.sub}, function(err, customer){
          if(err){
            return callback(errors['0010'], null);
          }
          if(!customer){
            var options = {};
            if(call.request.storePaymentDetails){
              options.source = call.request.source;
              stripe.customers.create(options, function(err, newCust){
                if(err){
                  return callback(errors['0010'], null);
                }
                var newCustToStore = new Customer({owner:token.sub, customer:newCust.id});
                newCustToStore.save(function(err, storedCustomer){
                  if(err){
                    callback(errors['0010'], null);
                  }
                  createPayment(call.request.subtotal, call.request.currency, call.request.source, paymentInfo.stripe_id, newCust.id, call.request.order, callback);
                })
              })
            }else{
              createPayment(call.request.subtotal, call.request.currency, call.request.source, paymentInfo.stripe_id, null, call.request.order, callback);
            }

          }else{
            if(call.request.storePaymentDetails){

              stripe.customers.retrieve(customer.customer, function(err, customerObj){
                if(err){
                  //something went wrong retrieving customeres existing payment paymentMethods
                  //ignore and carry on creating payment anyway.
                  return createPayment(call.request.subtotal, call.request.currency, call.request.source, paymentInfo.stripe_id, customer.customer, call.request.order, callback);
                }
                var canStore = true;
                if(customerObj.sources.data.length != 0){
                  //we need to retrieve the finger print of the token passed
                  stripe.tokens.retrieve(
                    call.request.source,
                    function(err, token) {
                      if(err){
                        //unable to store payment but rather than killing the whole transaction just send the payment info off.
                        //customers will have to add the card again later.
                        return createPayment(call.request.subtotal, call.request.currency, call.request.source, paymentInfo.stripe_id, customer.customer, call.request.order, callback);
                      }
                      //now we have the token finger print we need to check it against all the other stored fingerprints
                      for(var i = 0; i<customerObj.sources.data.length; i++){
                        if(customerObj.sources.data[i].fingerprint == token.card.fingerprint){
                          canStore = false;
                          break;
                        }
                      }

                      if(canStore){
                        //card doesnt exist, so store it first then create the payment
                        stripe.customers.createSource(customer.customer, {source:call.request.source}, function(err, updatedCustomer){
                          if(err){
                            //same justification as above
                          }
                          createPayment(call.request.subtotal, call.request.currency, call.request.source, paymentInfo.stripe_id, customer.customer, call.request.order, callback);
                        })
                      }else{
                        // card already exists, create payment and dont stored
                        return   createPayment(call.request.subtotal, call.request.currency, call.request.source, paymentInfo.stripe_id, customer.customer, call.request.order, callback);
                      }
                    }
                  );
                }
              });
            }else{
              createPayment(call.request.subtotal, call.request.currency, call.request.source, paymentInfo.stripe_id, customer.customer, call.request.order, callback);
            }////end of store payment details
          }
        })
      });
    })
  });
}

helper.capturePayment = function(call, callback){
  jwt.verify(call.metadata.get('authorization')[0], process.env.JWT_SECRET, function(err, token){
    if(err){
      return callback(errors['0009'], null);
    }
    Payment.findOne({"order": call.request.order}, function(paymentRetrievalError, payment){
      if(paymentRetrievalError){
        var metadata = new grpc.Metadata();
        metadata.add('error_code', '09000007');
        return callback({message:errors['0007'].message, code: errors['0007'].code, metadata: metadata},null);
      }else if(!payment){
        var metadata = new grpc.Metadata();
        metadata.add('error_code', '09000006');
        return callback({message:errors['0006'].message, code: errors['0006'].code, metadata: metadata},null);
      }else if(payment.captured){
        //payment already captured
        return callback(null, {captured: true});
      }else if(payment.refunded){
        //payment has been refunded
        return callback(null, {captured: false});
      }


      //update captured state
      stripe.charges.capture(payment.stripe_id).then(function(charge){
        payment.captured = true;
        payment.save(function(paymentUpdateError, paymentUpdated){
          if(paymentUpdateError){
            return callback(errors['0004'], null);
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
                return callback(errors['0004'],null);
              }
              return callback(null, {captured: false});
            });
          }
          if(err.message.includes('captured')){
              //payment has been captured
              payment.captured = true;
              payment.save((saveError) => {
                if(saveError){
                  return callback(errors['0004'],null);
                }
                return callback(null, {captured: true});
              });
          }
        }
      });

    });
  });
}

helper.refundPayment = function(call, callback){
  jwt.verify(call.metadata.get('authorization')[0], process.env.JWT_SECRET, function(err, token){
    if(err){
      return callback(errors['0009'],null);
    }

    Payment.findOne({"order": call.request.order}, function(paymentRetrievalError, payment){
      if(paymentRetrievalError){
        var metadata = new grpc.Metadata();
        metadata.add('error_code', '09010007');
        return callback({message:errors['0007'].message, code: errors['0007'].code, metadata: metadata},null);
      }else if(!payment){
        var metadata = new grpc.Metadata();
        metadata.add('error_code', '09010006');
        return callback({message:errors['0006'].message, code: errors['0006'].code, metadata: metadata},null);
      }else if(payment.refunded){
        //payment already captured
        return callback(null,{refunded: true});
      }
      //update captured state
      stripe.refunds.create({
          charge: payment.stripe_id,
          refund_application_fee: false
      }, function(refundError, paymentResponse){
        if(refundError){
          var metadata = new grpc.Metadata();
          metadata.add('error_code', '09000008');
          return callback({message:errors['0008'].message, code: errors['0008'].code, metadata: metadata},null);
        }
        return callback(null, {refunded: true});
      });
    });
  });
}

function createPayment(subtotal, currency, source, premisesAccountId, customerId, order, callback){
  if(!Number.isInteger(subtotal)){
    subtotal *= 100;
  }
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
          return callback(errors['0011'], null);
        }
        return callback(null, {});
      })
    }, function(err){
      console.log(err);
      return callback(errors['0011'],null);
    });
}


helper.getStoredPaymentMethods = function(call, callback){
  jwt.verify(call.metadata.get('authorization')[0], process.env.JWT_SECRET, function(err, token){
    if(err){
      return callback(errors['0009'],null);
    }

    Customer.findOne({owner: token.sub}, function(err, customer){
      if(err){
        return callback(errors['0012'],null);
      }
      if(customer){
        stripe.customers.retrieve(customer.customer, function(err, customerObj){
          if(err){return callback(errors['0012'],null);}
          var paymentMethods = {};
          paymentMethods.cards = [];
          for(var i=0;i<customerObj.sources.data.length;i++){
            var paymentMethod = customerObj.sources.data[i];
            if(paymentMethod.object == 'card'){
              //card has been stored
              var cardObj = {};
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
        return callback(errors['00012'], null);
      }
    })
  });
}


helper.wasRefunded = function(call, callback){
  if(call.request.charge_id){
    Payment.findOne({stripe_id: call.request.charge_id}, (error, result) => {
      if(error){
        return callback(errors['0001'], null);
      }
      result.refunded = true;
      result.save((err) => {
        if(err){
          return callback(errors['0003'], null);
        }else{
          return callback(null, {order_id:result.order});
        }
      });
    });
  }else{
    return callback(errors['0002'], null);
  }
}

function getConnectedAccountId(accountId){
  Premises.findOne({owner: accountId}).exec(function(err, paymentInfo){
    if(err){
      return callback(errors['0007'], null);
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
